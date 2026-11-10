-- =====================================================================
-- AulaNova · Migración v5: portada de curso, grupos, tareas grupales,
-- exposiciones y calificación rápida.
-- Ejecutar en Supabase > SQL Editor DESPUÉS de migracion-v4-clave-foto.sql.
-- Se puede ejecutar más de una vez.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. PORTADA DEL CURSO  (Storage: portadas-cursos/<curso_id>/foto.jpg)
-- ---------------------------------------------------------------------
ALTER TABLE public.cursos ADD COLUMN IF NOT EXISTS portada text;
ALTER TABLE public.cursos DROP CONSTRAINT IF EXISTS cursos_portada_ruta;
ALTER TABLE public.cursos ADD CONSTRAINT cursos_portada_ruta
  CHECK (portada IS NULL OR portada LIKE id::text || '/%');

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('portadas-cursos', 'portadas-cursos', false, 3145728,
        ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO UPDATE
  SET public = false, file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS storage_portadas_subir ON storage.objects;
CREATE POLICY storage_portadas_subir ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'portadas-cursos'
    AND EXISTS (SELECT 1 FROM public.cursos c
                WHERE c.id::text = (storage.foldername(name))[1]
                  AND private.docente_del_curso(c.id)));

DROP POLICY IF EXISTS storage_portadas_eliminar ON storage.objects;
CREATE POLICY storage_portadas_eliminar ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'portadas-cursos'
    AND EXISTS (SELECT 1 FROM public.cursos c
                WHERE c.id::text = (storage.foldername(name))[1]
                  AND private.docente_del_curso(c.id)));

DROP POLICY IF EXISTS storage_portadas_ver ON storage.objects;
CREATE POLICY storage_portadas_ver ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'portadas-cursos'
    AND EXISTS (SELECT 1 FROM public.cursos c
                WHERE c.id::text = (storage.foldername(name))[1]
                  AND (private.docente_del_curso(c.id) OR private.alumna_del_curso(c.id))));

-- ---------------------------------------------------------------------
-- 2. TAREAS: tipo "exposición" y modalidad individual / grupal
-- ---------------------------------------------------------------------
ALTER TABLE public.tareas DROP CONSTRAINT IF EXISTS tareas_tipo_check;
ALTER TABLE public.tareas ADD CONSTRAINT tareas_tipo_check
  CHECK (tipo IN ('tarea', 'proyecto', 'practica', 'investigacion', 'exposicion'));

ALTER TABLE public.tareas ADD COLUMN IF NOT EXISTS modalidad varchar(12) NOT NULL DEFAULT 'individual';
ALTER TABLE public.tareas DROP CONSTRAINT IF EXISTS tareas_modalidad_check;
ALTER TABLE public.tareas ADD CONSTRAINT tareas_modalidad_check
  CHECK (modalidad IN ('individual', 'grupal'));

-- ---------------------------------------------------------------------
-- 3. GRUPOS (una alumna está en un solo grupo por curso)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.grupos (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  curso_id  uuid NOT NULL REFERENCES public.cursos(id) ON DELETE CASCADE,
  nombre    varchar(100) NOT NULL,
  creado_en timestamptz NOT NULL DEFAULT now(),
  UNIQUE (curso_id, nombre)
);
CREATE INDEX IF NOT EXISTS idx_grupos_curso ON public.grupos(curso_id);

CREATE TABLE IF NOT EXISTS public.grupo_integrantes (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grupo_id  uuid NOT NULL REFERENCES public.grupos(id) ON DELETE CASCADE,
  curso_id  uuid NOT NULL REFERENCES public.cursos(id) ON DELETE CASCADE,
  alumna_id uuid NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
  UNIQUE (curso_id, alumna_id)
);
CREATE INDEX IF NOT EXISTS idx_integrantes_grupo ON public.grupo_integrantes(grupo_id);
CREATE INDEX IF NOT EXISTS idx_integrantes_alumna ON public.grupo_integrantes(alumna_id);

-- El curso del integrante se toma del grupo, y la alumna debe estar inscrita
CREATE OR REPLACE FUNCTION private.preparar_integrante() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  SELECT curso_id INTO NEW.curso_id FROM public.grupos WHERE id = NEW.grupo_id;
  IF NEW.curso_id IS NULL THEN RAISE EXCEPTION 'Grupo no encontrado'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.inscripciones
                 WHERE curso_id = NEW.curso_id AND alumna_id = NEW.alumna_id) THEN
    RAISE EXCEPTION 'La alumna no está inscrita en el curso de este grupo';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS preparar_integrante_trigger ON public.grupo_integrantes;
CREATE TRIGGER preparar_integrante_trigger
  BEFORE INSERT OR UPDATE ON public.grupo_integrantes
  FOR EACH ROW EXECUTE FUNCTION private.preparar_integrante();

-- ¿Esta alumna está en mi grupo?
CREATE OR REPLACE FUNCTION private.es_companera(p_alumna uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.grupo_integrantes a
                 JOIN public.grupo_integrantes b ON b.grupo_id = a.grupo_id
                 WHERE a.alumna_id = (SELECT auth.uid()) AND b.alumna_id = p_alumna);
$$;

-- ¿Esta alumna está en mi grupo, y la tarea es grupal de ese curso?
CREATE OR REPLACE FUNCTION private.companera_en_tarea(p_alumna uuid, p_tarea uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.tareas t
                 JOIN public.grupo_integrantes a ON a.curso_id = t.curso_id
                 JOIN public.grupo_integrantes b ON b.grupo_id = a.grupo_id
                 WHERE t.id = p_tarea AND t.modalidad = 'grupal'
                   AND a.alumna_id = (SELECT auth.uid()) AND b.alumna_id = p_alumna);
$$;

REVOKE ALL ON FUNCTION private.preparar_integrante() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.es_companera(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.companera_en_tarea(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.es_companera(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.companera_en_tarea(uuid, uuid) TO authenticated;

ALTER TABLE public.grupos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.grupo_integrantes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.grupos, public.grupo_integrantes FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.grupos TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.grupo_integrantes TO authenticated;

DROP POLICY IF EXISTS grupos_ver ON public.grupos;
CREATE POLICY grupos_ver ON public.grupos FOR SELECT TO authenticated
  USING (private.docente_del_curso(curso_id) OR private.alumna_del_curso(curso_id));
DROP POLICY IF EXISTS grupos_crear ON public.grupos;
CREATE POLICY grupos_crear ON public.grupos FOR INSERT TO authenticated
  WITH CHECK (private.docente_del_curso(curso_id));
DROP POLICY IF EXISTS grupos_editar ON public.grupos;
CREATE POLICY grupos_editar ON public.grupos FOR UPDATE TO authenticated
  USING (private.docente_del_curso(curso_id)) WITH CHECK (private.docente_del_curso(curso_id));
DROP POLICY IF EXISTS grupos_eliminar ON public.grupos;
CREATE POLICY grupos_eliminar ON public.grupos FOR DELETE TO authenticated
  USING (private.docente_del_curso(curso_id));

DROP POLICY IF EXISTS integrantes_ver ON public.grupo_integrantes;
CREATE POLICY integrantes_ver ON public.grupo_integrantes FOR SELECT TO authenticated
  USING (private.docente_del_curso(curso_id) OR private.alumna_del_curso(curso_id));
DROP POLICY IF EXISTS integrantes_crear ON public.grupo_integrantes;
CREATE POLICY integrantes_crear ON public.grupo_integrantes FOR INSERT TO authenticated
  WITH CHECK (private.docente_del_curso(curso_id));
DROP POLICY IF EXISTS integrantes_eliminar ON public.grupo_integrantes;
CREATE POLICY integrantes_eliminar ON public.grupo_integrantes FOR DELETE TO authenticated
  USING (private.docente_del_curso(curso_id));

-- Las alumnas ven el nombre de sus compañeras de grupo
DROP POLICY IF EXISTS usuarios_ver_companeras ON public.usuarios;
CREATE POLICY usuarios_ver_companeras ON public.usuarios FOR SELECT TO authenticated
  USING (private.es_companera(id));

-- En tareas grupales, cada integrante ve la entrega (y archivos) de su grupo
DROP POLICY IF EXISTS entregas_ver_grupo ON public.entregas;
CREATE POLICY entregas_ver_grupo ON public.entregas FOR SELECT TO authenticated
  USING (private.companera_en_tarea(alumna_id, tarea_id));

DROP POLICY IF EXISTS archivos_ver_grupo ON public.archivos_entrega;
CREATE POLICY archivos_ver_grupo ON public.archivos_entrega FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.entregas e
                 WHERE e.id = archivos_entrega.entrega_id
                   AND private.companera_en_tarea(e.alumna_id, e.tarea_id)));

DROP POLICY IF EXISTS storage_tareas_ver_grupo ON storage.objects;
CREATE POLICY storage_tareas_ver_grupo ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'tareas-escolares'
    AND EXISTS (SELECT 1 FROM public.entregas e
                WHERE e.id::text = (storage.foldername(name))[2]
                  AND private.companera_en_tarea(e.alumna_id, e.tarea_id)));

-- ---------------------------------------------------------------------
-- 4. CALIFICACIÓN RÁPIDA (sirve para exposiciones: no hace falta entrega)
--    p_nota = NULL quita la nota.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.calificar(p_tarea uuid, p_alumna uuid, p_nota numeric, p_comentario text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_curso uuid; v_entrega uuid;
BEGIN
  IF NOT private.docente_de_tarea(p_tarea) THEN
    RAISE EXCEPTION 'No eres docente de esta tarea';
  END IF;
  SELECT curso_id INTO v_curso FROM public.tareas WHERE id = p_tarea;
  IF NOT EXISTS (SELECT 1 FROM public.inscripciones WHERE curso_id = v_curso AND alumna_id = p_alumna) THEN
    RAISE EXCEPTION 'La alumna no está inscrita en este curso';
  END IF;
  SELECT id INTO v_entrega FROM public.entregas WHERE tarea_id = p_tarea AND alumna_id = p_alumna;

  IF p_nota IS NULL THEN
    DELETE FROM public.calificaciones WHERE entrega_id = v_entrega;
    RETURN;
  END IF;
  IF v_entrega IS NULL THEN
    INSERT INTO public.entregas (tarea_id, alumna_id) VALUES (p_tarea, p_alumna)
    RETURNING id INTO v_entrega;
  END IF;
  INSERT INTO public.calificaciones (entrega_id, docente_id, nota, comentario)
  VALUES (v_entrega, (SELECT auth.uid()), p_nota, nullif(trim(p_comentario), ''))
  ON CONFLICT (entrega_id) DO UPDATE
    SET nota = EXCLUDED.nota, comentario = EXCLUDED.comentario, docente_id = EXCLUDED.docente_id;
END $$;

-- Una nota para todo el grupo: se copia a cada integrante
CREATE OR REPLACE FUNCTION public.calificar_grupo(p_tarea uuid, p_grupo uuid, p_nota numeric, p_comentario text DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r record; n integer := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.grupos g JOIN public.tareas t ON t.curso_id = g.curso_id
                 WHERE g.id = p_grupo AND t.id = p_tarea) THEN
    RAISE EXCEPTION 'El grupo no pertenece al curso de esta tarea';
  END IF;
  FOR r IN SELECT alumna_id FROM public.grupo_integrantes WHERE grupo_id = p_grupo LOOP
    PERFORM public.calificar(p_tarea, r.alumna_id, p_nota, p_comentario);
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION public.calificar(uuid, uuid, numeric, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.calificar_grupo(uuid, uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.calificar(uuid, uuid, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.calificar_grupo(uuid, uuid, numeric, text) TO authenticated;
