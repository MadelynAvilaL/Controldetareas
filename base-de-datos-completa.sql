-- =====================================================================
-- AULANOVA · BASE DE DATOS COMPLETA (proyecto nuevo de Supabase)
-- Plataforma de tareas para docentes y alumnas, sin correo real.
--
-- Incluye todo lo anterior en un solo archivo:
--   script original + ajuste-sql.sql + migracion-classroom.sql
--   + migracion-v3.sql (ya corregidos).
--
-- CÓMO USARLO: en el proyecto NUEVO, abre SQL Editor > New query,
-- pega TODO este archivo y dale Run UNA sola vez.
-- Los pasos que siguen después (crear docente, Edge Function, etc.)
-- están al final del archivo.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE SCHEMA IF NOT EXISTS private;

-- =====================================================================
-- 1. TABLAS
-- =====================================================================

-- Perfiles. El id es el mismo de auth.users.
CREATE TABLE public.usuarios (
  id         uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  usuario    varchar(50)  NOT NULL UNIQUE,
  nombre     varchar(100) NOT NULL,
  apellido   varchar(100) NOT NULL,
  rol        varchar(20)  NOT NULL CHECK (rol IN ('docente', 'alumna')),
  activo     boolean      NOT NULL DEFAULT true,
  creado_en  timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT usuario_formato CHECK (usuario ~ '^[a-z0-9._-]{3,50}$')
);

CREATE TABLE public.cursos (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre        varchar(150) NOT NULL,
  descripcion   text,
  grado         varchar(50)  NOT NULL,
  seccion       varchar(20)  NOT NULL,
  ciclo_escolar integer      NOT NULL DEFAULT EXTRACT(YEAR FROM CURRENT_DATE)::integer,
  docente_id    uuid         NOT NULL REFERENCES public.usuarios(id),
  codigo_clase  varchar(7)   UNIQUE DEFAULT upper(substr(md5(gen_random_uuid()::text), 1, 7)),
  activo        boolean      NOT NULL DEFAULT true,
  creado_en     timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE public.inscripciones (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  curso_id          uuid NOT NULL REFERENCES public.cursos(id) ON DELETE CASCADE,
  alumna_id         uuid NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
  fecha_inscripcion timestamptz NOT NULL DEFAULT now(),
  UNIQUE (curso_id, alumna_id)
);

CREATE TABLE public.tareas (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  curso_id               uuid NOT NULL REFERENCES public.cursos(id) ON DELETE CASCADE,
  titulo                 varchar(200) NOT NULL,
  descripcion            text NOT NULL,
  instrucciones          text,
  tipo                   varchar(30) NOT NULL DEFAULT 'tarea'
                         CHECK (tipo IN ('tarea', 'proyecto', 'practica', 'investigacion')),
  puntos_maximos         numeric(7,2) NOT NULL DEFAULT 100 CHECK (puntos_maximos > 0),
  fecha_publicacion      timestamptz NOT NULL DEFAULT now(),
  fecha_limite           timestamptz NOT NULL,
  permite_entrega_tardia boolean NOT NULL DEFAULT false,
  publicada              boolean NOT NULL DEFAULT false,
  creado_en              timestamptz NOT NULL DEFAULT now(),
  CHECK (fecha_limite > fecha_publicacion)
);

-- Material de apoyo que adjunta la docente (Storage: material/<tarea_id>/...)
CREATE TABLE public.archivos_tarea (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tarea_id       uuid NOT NULL REFERENCES public.tareas(id) ON DELETE CASCADE,
  nombre_archivo text NOT NULL,
  ruta_storage   text NOT NULL UNIQUE,
  tipo_archivo   text,
  tamano_bytes   bigint CHECK (tamano_bytes >= 0),
  creado_en      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT archivos_tarea_ruta
    CHECK (ruta_storage LIKE 'material/' || tarea_id::text || '/%')
);

-- Una entrega por alumna y por tarea
CREATE TABLE public.entregas (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tarea_id       uuid NOT NULL REFERENCES public.tareas(id) ON DELETE CASCADE,
  alumna_id      uuid NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
  contenido      text,
  enlace         text,
  fecha_entrega  timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tarea_id, alumna_id)
);

-- Archivos de la alumna (Storage: <alumna_id>/<entrega_id>/...)
CREATE TABLE public.archivos_entrega (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entrega_id     uuid NOT NULL REFERENCES public.entregas(id) ON DELETE CASCADE,
  nombre_archivo text NOT NULL,
  ruta_storage   text NOT NULL UNIQUE,
  tipo_archivo   text,
  tamano_bytes   bigint CHECK (tamano_bytes >= 0),
  creado_en      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.calificaciones (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entrega_id    uuid NOT NULL UNIQUE REFERENCES public.entregas(id) ON DELETE CASCADE,
  docente_id    uuid NOT NULL REFERENCES public.usuarios(id),
  nota          numeric(7,2) NOT NULL CHECK (nota >= 0),
  comentario    text,
  calificado_en timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.anuncios (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  curso_id   uuid NOT NULL REFERENCES public.cursos(id) ON DELETE CASCADE,
  docente_id uuid NOT NULL REFERENCES public.usuarios(id),
  titulo     varchar(200) NOT NULL,
  contenido  text NOT NULL,
  creado_en  timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- 2. ÍNDICES
-- =====================================================================
CREATE INDEX idx_cursos_docente         ON public.cursos(docente_id);
CREATE INDEX idx_inscripciones_alumna   ON public.inscripciones(alumna_id);
CREATE INDEX idx_tareas_curso           ON public.tareas(curso_id);
CREATE INDEX idx_archivos_tarea         ON public.archivos_tarea(tarea_id);
CREATE INDEX idx_entregas_alumna        ON public.entregas(alumna_id);
CREATE INDEX idx_entregas_tarea         ON public.entregas(tarea_id);
CREATE INDEX idx_archivos_entrega       ON public.archivos_entrega(entrega_id);
CREATE INDEX idx_calificaciones_docente ON public.calificaciones(docente_id);
CREATE INDEX idx_anuncios_curso         ON public.anuncios(curso_id);

-- =====================================================================
-- 3. FUNCIONES DE AUTORIZACIÓN (evitan consultas recursivas en RLS)
-- =====================================================================
CREATE FUNCTION private.es_docente() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.usuarios
                 WHERE id = (SELECT auth.uid()) AND rol = 'docente' AND activo);
$$;

CREATE FUNCTION private.es_alumna() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.usuarios
                 WHERE id = (SELECT auth.uid()) AND rol = 'alumna' AND activo);
$$;

CREATE FUNCTION private.docente_del_curso(p_curso uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.es_docente() AND EXISTS (
    SELECT 1 FROM public.cursos WHERE id = p_curso AND docente_id = (SELECT auth.uid()));
$$;

CREATE FUNCTION private.alumna_del_curso(p_curso uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.es_alumna() AND EXISTS (
    SELECT 1 FROM public.inscripciones WHERE curso_id = p_curso AND alumna_id = (SELECT auth.uid()));
$$;

CREATE FUNCTION private.puede_ver_alumna(p_alumna uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.es_docente() AND EXISTS (
    SELECT 1 FROM public.inscripciones i JOIN public.cursos c ON c.id = i.curso_id
    WHERE i.alumna_id = p_alumna AND c.docente_id = (SELECT auth.uid()));
$$;

CREATE FUNCTION private.puede_entregar(p_tarea uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.es_alumna() AND EXISTS (
    SELECT 1 FROM public.tareas t JOIN public.inscripciones i ON i.curso_id = t.curso_id
    WHERE t.id = p_tarea AND t.publicada
      AND i.alumna_id = (SELECT auth.uid())
      AND (t.permite_entrega_tardia OR now() <= t.fecha_limite));
$$;

CREATE FUNCTION private.docente_de_tarea(p_tarea uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.es_docente() AND EXISTS (
    SELECT 1 FROM public.tareas t JOIN public.cursos c ON c.id = t.curso_id
    WHERE t.id = p_tarea AND c.docente_id = (SELECT auth.uid()));
$$;

CREATE FUNCTION private.puede_ver_tarea(p_tarea uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.tareas t
    WHERE t.id = p_tarea
      AND (private.docente_del_curso(t.curso_id)
           OR (t.publicada AND private.alumna_del_curso(t.curso_id))));
$$;

CREATE FUNCTION private.docente_de_entrega(p_entrega uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.es_docente() AND EXISTS (
    SELECT 1 FROM public.entregas e
    JOIN public.tareas t ON t.id = e.tarea_id
    JOIN public.cursos c ON c.id = t.curso_id
    WHERE e.id = p_entrega AND c.docente_id = (SELECT auth.uid()));
$$;

CREATE FUNCTION private.alumna_de_entrega(p_entrega uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.es_alumna() AND EXISTS (
    SELECT 1 FROM public.entregas WHERE id = p_entrega AND alumna_id = (SELECT auth.uid()));
$$;

-- =====================================================================
-- 4. TRIGGERS (validaciones automáticas)
-- =====================================================================

-- Solo se inscriben alumnas activas
CREATE FUNCTION private.validar_inscripcion() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.usuarios
                 WHERE id = NEW.alumna_id AND rol = 'alumna' AND activo) THEN
    RAISE EXCEPTION 'El usuario no es una alumna activa';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validar_inscripcion_trigger
  BEFORE INSERT OR UPDATE ON public.inscripciones
  FOR EACH ROW EXECUTE FUNCTION private.validar_inscripcion();

-- La nota no supera los puntos y la pone la docente del curso
CREATE FUNCTION private.validar_calificacion() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE maximo numeric(7,2); responsable uuid;
BEGIN
  SELECT t.puntos_maximos, c.docente_id INTO maximo, responsable
  FROM public.entregas e
  JOIN public.tareas t ON t.id = e.tarea_id
  JOIN public.cursos c ON c.id = t.curso_id
  WHERE e.id = NEW.entrega_id;
  IF maximo IS NULL THEN RAISE EXCEPTION 'Entrega no encontrada'; END IF;
  IF NEW.nota > maximo THEN
    RAISE EXCEPTION 'La nota (%) supera el máximo de la tarea (%)', NEW.nota, maximo;
  END IF;
  IF NEW.docente_id IS DISTINCT FROM responsable THEN
    RAISE EXCEPTION 'Docente no autorizado';
  END IF;
  NEW.calificado_en := now();
  RETURN NEW;
END $$;
CREATE TRIGGER validar_calificacion_trigger
  BEFORE INSERT OR UPDATE ON public.calificaciones
  FOR EACH ROW EXECUTE FUNCTION private.validar_calificacion();

-- Fecha de última modificación de la entrega
CREATE FUNCTION private.tocar_actualizado_en() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN NEW.actualizado_en := now(); RETURN NEW; END $$;
CREATE TRIGGER entregas_actualizado_en
  BEFORE UPDATE ON public.entregas
  FOR EACH ROW EXECUTE FUNCTION private.tocar_actualizado_en();

-- Crear el perfil automáticamente al crear una cuenta usuario@alumnas.invalid
-- (siempre como alumna; a una docente se le cambia el rol a mano)
CREATE FUNCTION private.crear_perfil() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_usuario text := lower(split_part(NEW.email, '@', 1));
BEGIN
  IF NEW.email NOT ILIKE '%@alumnas.invalid' THEN RETURN NEW; END IF;
  INSERT INTO public.usuarios (id, usuario, nombre, apellido, rol)
  VALUES (NEW.id, v_usuario,
          coalesce(NEW.raw_user_meta_data->>'nombre', v_usuario),
          coalesce(NEW.raw_user_meta_data->>'apellido', '-'),
          'alumna')
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER al_crear_usuario
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION private.crear_perfil();

-- =====================================================================
-- 5. FUNCIONES QUE LLAMA LA APP (RPC)
-- =====================================================================

-- La alumna se une a una clase con el código
CREATE FUNCTION public.unirse_a_curso(p_codigo text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_curso uuid;
BEGIN
  IF NOT private.es_alumna() THEN
    RAISE EXCEPTION 'Solo una alumna activa puede unirse a una clase';
  END IF;
  SELECT id INTO v_curso FROM public.cursos
  WHERE codigo_clase = upper(trim(p_codigo)) AND activo;
  IF v_curso IS NULL THEN RAISE EXCEPTION 'Código de clase no válido'; END IF;
  INSERT INTO public.inscripciones (curso_id, alumna_id)
  VALUES (v_curso, auth.uid())
  ON CONFLICT (curso_id, alumna_id) DO NOTHING;
  RETURN v_curso;
END $$;

-- La docente inscribe a una alumna por su nombre de usuario
CREATE FUNCTION public.inscribir_alumna(p_curso uuid, p_usuario text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_alumna uuid;
BEGIN
  IF NOT private.docente_del_curso(p_curso) THEN
    RAISE EXCEPTION 'No eres docente de este curso';
  END IF;
  SELECT id INTO v_alumna FROM public.usuarios
  WHERE usuario = lower(trim(p_usuario)) AND rol = 'alumna' AND activo;
  IF v_alumna IS NULL THEN
    RAISE EXCEPTION 'No existe una alumna activa con ese usuario';
  END IF;
  INSERT INTO public.inscripciones (curso_id, alumna_id)
  VALUES (p_curso, v_alumna)
  ON CONFLICT (curso_id, alumna_id) DO NOTHING;
END $$;

-- =====================================================================
-- 6. PERMISOS
-- =====================================================================
ALTER TABLE public.usuarios         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cursos           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inscripciones    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tareas           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.archivos_tarea   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entregas         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.archivos_entrega ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calificaciones   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.anuncios         ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
GRANT USAGE ON SCHEMA public  TO authenticated;
GRANT USAGE ON SCHEMA private TO authenticated;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC, anon;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA private TO authenticated;

REVOKE ALL ON FUNCTION public.unirse_a_curso(text)          FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.inscribir_alumna(uuid, text)  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unirse_a_curso(text)         TO authenticated;
GRANT EXECUTE ON FUNCTION public.inscribir_alumna(uuid, text) TO authenticated;

-- El cliente no puede crear perfiles ni cambiar roles
GRANT SELECT                         ON public.usuarios         TO authenticated;
GRANT SELECT, INSERT, UPDATE         ON public.cursos           TO authenticated;
GRANT SELECT, INSERT, DELETE         ON public.inscripciones    TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tareas           TO authenticated;
GRANT SELECT, INSERT, DELETE         ON public.archivos_tarea   TO authenticated;
GRANT SELECT, INSERT                 ON public.entregas         TO authenticated;
GRANT UPDATE (contenido, enlace)     ON public.entregas         TO authenticated;
GRANT SELECT, INSERT, DELETE         ON public.archivos_entrega TO authenticated;
GRANT SELECT, INSERT, UPDATE         ON public.calificaciones   TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.anuncios         TO authenticated;

-- =====================================================================
-- 7. POLÍTICAS RLS
-- =====================================================================

-- USUARIOS
CREATE POLICY usuarios_ver ON public.usuarios FOR SELECT TO authenticated
  USING (id = (SELECT auth.uid()) OR private.puede_ver_alumna(id));

-- CURSOS
CREATE POLICY cursos_ver ON public.cursos FOR SELECT TO authenticated
  USING (private.docente_del_curso(id) OR private.alumna_del_curso(id));
CREATE POLICY cursos_ver_propios ON public.cursos FOR SELECT TO authenticated
  USING (docente_id = (SELECT auth.uid()));
CREATE POLICY cursos_crear ON public.cursos FOR INSERT TO authenticated
  WITH CHECK (docente_id = (SELECT auth.uid()) AND private.es_docente());
CREATE POLICY cursos_editar ON public.cursos FOR UPDATE TO authenticated
  USING (private.docente_del_curso(id))
  WITH CHECK (docente_id = (SELECT auth.uid()) AND private.es_docente());

-- INSCRIPCIONES
CREATE POLICY inscripciones_ver ON public.inscripciones FOR SELECT TO authenticated
  USING (alumna_id = (SELECT auth.uid()) OR private.docente_del_curso(curso_id));
CREATE POLICY inscripciones_crear ON public.inscripciones FOR INSERT TO authenticated
  WITH CHECK (private.docente_del_curso(curso_id));
CREATE POLICY inscripciones_eliminar ON public.inscripciones FOR DELETE TO authenticated
  USING (private.docente_del_curso(curso_id));

-- TAREAS
CREATE POLICY tareas_ver ON public.tareas FOR SELECT TO authenticated
  USING (private.docente_del_curso(curso_id)
         OR (publicada AND private.alumna_del_curso(curso_id)));
CREATE POLICY tareas_crear ON public.tareas FOR INSERT TO authenticated
  WITH CHECK (private.docente_del_curso(curso_id));
CREATE POLICY tareas_editar ON public.tareas FOR UPDATE TO authenticated
  USING (private.docente_del_curso(curso_id))
  WITH CHECK (private.docente_del_curso(curso_id));
CREATE POLICY tareas_eliminar ON public.tareas FOR DELETE TO authenticated
  USING (private.docente_del_curso(curso_id));

-- MATERIAL DE TAREAS
CREATE POLICY archivos_tarea_ver ON public.archivos_tarea FOR SELECT TO authenticated
  USING (private.puede_ver_tarea(tarea_id));
CREATE POLICY archivos_tarea_crear ON public.archivos_tarea FOR INSERT TO authenticated
  WITH CHECK (private.docente_de_tarea(tarea_id));
CREATE POLICY archivos_tarea_eliminar ON public.archivos_tarea FOR DELETE TO authenticated
  USING (private.docente_de_tarea(tarea_id));

-- ENTREGAS
CREATE POLICY entregas_ver ON public.entregas FOR SELECT TO authenticated
  USING (alumna_id = (SELECT auth.uid()) OR private.docente_de_tarea(tarea_id));
CREATE POLICY entregas_crear ON public.entregas FOR INSERT TO authenticated
  WITH CHECK (alumna_id = (SELECT auth.uid()) AND private.puede_entregar(tarea_id));
CREATE POLICY entregas_editar ON public.entregas FOR UPDATE TO authenticated
  USING (alumna_id = (SELECT auth.uid())
         AND private.puede_entregar(tarea_id)
         AND NOT EXISTS (SELECT 1 FROM public.calificaciones c WHERE c.entrega_id = entregas.id))
  WITH CHECK (alumna_id = (SELECT auth.uid()) AND private.puede_entregar(tarea_id));

-- ARCHIVOS DE ENTREGAS
CREATE POLICY archivos_ver ON public.archivos_entrega FOR SELECT TO authenticated
  USING (private.alumna_de_entrega(entrega_id) OR private.docente_de_entrega(entrega_id));
CREATE POLICY archivos_crear ON public.archivos_entrega FOR INSERT TO authenticated
  WITH CHECK (
    private.alumna_de_entrega(entrega_id)
    AND EXISTS (SELECT 1 FROM public.entregas e
                WHERE e.id = archivos_entrega.entrega_id
                  AND private.puede_entregar(e.tarea_id)
                  AND NOT EXISTS (SELECT 1 FROM public.calificaciones c WHERE c.entrega_id = e.id))
    AND ruta_storage LIKE (SELECT auth.uid())::text || '/' || entrega_id::text || '/%');
CREATE POLICY archivos_eliminar ON public.archivos_entrega FOR DELETE TO authenticated
  USING (
    private.alumna_de_entrega(entrega_id)
    AND EXISTS (SELECT 1 FROM public.entregas e
                WHERE e.id = archivos_entrega.entrega_id
                  AND private.puede_entregar(e.tarea_id)
                  AND NOT EXISTS (SELECT 1 FROM public.calificaciones c WHERE c.entrega_id = e.id)));

-- CALIFICACIONES
CREATE POLICY calificaciones_ver ON public.calificaciones FOR SELECT TO authenticated
  USING (private.alumna_de_entrega(entrega_id) OR private.docente_de_entrega(entrega_id));
CREATE POLICY calificaciones_crear ON public.calificaciones FOR INSERT TO authenticated
  WITH CHECK (docente_id = (SELECT auth.uid()) AND private.docente_de_entrega(entrega_id));
CREATE POLICY calificaciones_editar ON public.calificaciones FOR UPDATE TO authenticated
  USING (docente_id = (SELECT auth.uid()) AND private.docente_de_entrega(entrega_id))
  WITH CHECK (docente_id = (SELECT auth.uid()) AND private.docente_de_entrega(entrega_id));

-- ANUNCIOS
CREATE POLICY anuncios_ver ON public.anuncios FOR SELECT TO authenticated
  USING (private.docente_del_curso(curso_id) OR private.alumna_del_curso(curso_id));
CREATE POLICY anuncios_crear ON public.anuncios FOR INSERT TO authenticated
  WITH CHECK (docente_id = (SELECT auth.uid()) AND private.docente_del_curso(curso_id));
CREATE POLICY anuncios_editar ON public.anuncios FOR UPDATE TO authenticated
  USING (docente_id = (SELECT auth.uid()) AND private.docente_del_curso(curso_id))
  WITH CHECK (docente_id = (SELECT auth.uid()) AND private.docente_del_curso(curso_id));
CREATE POLICY anuncios_eliminar ON public.anuncios FOR DELETE TO authenticated
  USING (docente_id = (SELECT auth.uid()) AND private.docente_del_curso(curso_id));

-- =====================================================================
-- 8. ALMACENAMIENTO DE ARCHIVOS (bucket privado, 10 MB por archivo)
-- =====================================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('tareas-escolares', 'tareas-escolares', false, 10485760, ARRAY[
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/png', 'image/jpeg', 'text/plain',
  'application/zip', 'application/x-zip-compressed'
])
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Entregas de alumnas: <alumna_id>/<entrega_id>/archivo
CREATE POLICY storage_tareas_subir ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'tareas-escolares'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
    AND EXISTS (SELECT 1 FROM public.entregas e
                WHERE e.id::text = (storage.foldername(name))[2]
                  AND e.alumna_id = (SELECT auth.uid())
                  AND private.puede_entregar(e.tarea_id)
                  AND NOT EXISTS (SELECT 1 FROM public.calificaciones c WHERE c.entrega_id = e.id)));

CREATE POLICY storage_tareas_ver ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'tareas-escolares'
    AND EXISTS (SELECT 1 FROM public.entregas e
                WHERE e.id::text = (storage.foldername(name))[2]
                  AND (e.alumna_id = (SELECT auth.uid()) OR private.docente_de_entrega(e.id))));

CREATE POLICY storage_tareas_eliminar ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'tareas-escolares'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
    AND EXISTS (SELECT 1 FROM public.entregas e
                WHERE e.id::text = (storage.foldername(name))[2]
                  AND e.alumna_id = (SELECT auth.uid())
                  AND private.puede_entregar(e.tarea_id)
                  AND NOT EXISTS (SELECT 1 FROM public.calificaciones c WHERE c.entrega_id = e.id)));

-- Material de tareas: material/<tarea_id>/archivo
CREATE POLICY storage_material_subir ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'tareas-escolares'
    AND (storage.foldername(name))[1] = 'material'
    AND EXISTS (SELECT 1 FROM public.tareas t
                WHERE t.id::text = (storage.foldername(name))[2]
                  AND private.docente_de_tarea(t.id)));

CREATE POLICY storage_material_ver ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'tareas-escolares'
    AND (storage.foldername(name))[1] = 'material'
    AND EXISTS (SELECT 1 FROM public.tareas t
                WHERE t.id::text = (storage.foldername(name))[2]
                  AND private.puede_ver_tarea(t.id)));

CREATE POLICY storage_material_eliminar ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'tareas-escolares'
    AND (storage.foldername(name))[1] = 'material'
    AND EXISTS (SELECT 1 FROM public.tareas t
                WHERE t.id::text = (storage.foldername(name))[2]
                  AND private.docente_de_tarea(t.id)));

-- =====================================================================
-- 9. NÚMERO DE CLAVE Y FOTO DE PERFIL
-- =====================================================================

-- 1. Columnas nuevas en usuarios
ALTER TABLE public.usuarios ADD COLUMN IF NOT EXISTS clave integer CHECK (clave > 0);
ALTER TABLE public.usuarios ADD COLUMN IF NOT EXISTS foto text;
ALTER TABLE public.usuarios DROP CONSTRAINT IF EXISTS usuarios_foto_ruta;
ALTER TABLE public.usuarios ADD CONSTRAINT usuarios_foto_ruta
  CHECK (foto IS NULL OR foto LIKE id::text || '/%');

-- 2. Cada persona puede cambiar SOLO su propia foto (no su nombre ni su rol)
GRANT UPDATE (foto) ON public.usuarios TO authenticated;
DROP POLICY IF EXISTS usuarios_editar_foto ON public.usuarios;
CREATE POLICY usuarios_editar_foto ON public.usuarios FOR UPDATE TO authenticated
  USING (id = (SELECT auth.uid()))
  WITH CHECK (id = (SELECT auth.uid()));

-- 3. ¿Puede el usuario actual ver la foto de esta persona?
--    Su propia foto; la docente ve a sus alumnas; la alumna ve a sus docentes.
CREATE OR REPLACE FUNCTION private.puede_ver_foto(p_usuario text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p_usuario = (SELECT auth.uid())::text
      OR EXISTS (SELECT 1 FROM public.usuarios u
                 WHERE u.id::text = p_usuario AND private.puede_ver_alumna(u.id))
      OR EXISTS (SELECT 1 FROM public.cursos c
                 JOIN public.inscripciones i ON i.curso_id = c.id
                 WHERE c.docente_id::text = p_usuario
                   AND i.alumna_id = (SELECT auth.uid()));
$$;
REVOKE ALL ON FUNCTION private.puede_ver_foto(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.puede_ver_foto(text) TO authenticated;

-- 4. Bucket privado para fotos (máx. 2 MB; la app las reduce a ~30 KB)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('fotos-perfil', 'fotos-perfil', false, 2097152,
        ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO UPDATE
  SET public = false, file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Ruta: <usuario_id>/<archivo>.jpg
DROP POLICY IF EXISTS storage_fotos_subir ON storage.objects;
CREATE POLICY storage_fotos_subir ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'fotos-perfil'
              AND (storage.foldername(name))[1] = (SELECT auth.uid())::text);

DROP POLICY IF EXISTS storage_fotos_eliminar ON storage.objects;
CREATE POLICY storage_fotos_eliminar ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'fotos-perfil'
         AND (storage.foldername(name))[1] = (SELECT auth.uid())::text);

DROP POLICY IF EXISTS storage_fotos_ver ON storage.objects;
CREATE POLICY storage_fotos_ver ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'fotos-perfil'
         AND private.puede_ver_foto((storage.foldername(name))[1]));

-- =====================================================================
-- FIN DEL SCRIPT
-- =====================================================================
--
-- PASOS DESPUÉS DE EJECUTARLO
--
-- A) Configuración de Auth (Authentication > Sign In / Providers):
--    desactiva "Allow new users to sign up".
--
-- B) Crear la primera docente:
--    1. Authentication > Users > Add user > Create new user
--       Email: docente.usuario@alumnas.invalid   (ej. lady.mo@alumnas.invalid)
--       Password: la que quieras · marca "Auto Confirm User".
--    2. Se crea sola como alumna; conviértela en docente ejecutando
--       (cambia el usuario, nombre y apellido):
--
--    UPDATE public.usuarios
--    SET rol = 'docente', nombre = 'Lady', apellido = 'Mo'
--    WHERE usuario = 'lady.mo';
--
-- C) Edge Function "gestionar-alumnas" (crear cuentas y cambiar
--    contraseñas desde la app): Edge Functions > Deploy a new function
--    > Via Editor, nombre gestionar-alumnas, pega el archivo
--    supabase/functions/gestionar-alumnas/index.ts y desactiva
--    "Verify JWT".
--
-- D) En js/config.js pon la Project URL y la clave publishable del
--    proyecto NUEVO.
--
-- E) Alumnas: ejecuta los scripts de la carpeta carga-alumnas
--    (crear-alumnas-segundo.sql, crear-alumnas-tercero.sql,
--    crear-alumnas-cuarto-c.sql) y después asignar-claves.sql.
-- =====================================================================
