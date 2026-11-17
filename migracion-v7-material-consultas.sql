-- =====================================================================
-- VILLA DE LAS NIÑAS · MIGRACIÓN v7
--   1. Material de lectura (archivos y enlaces que NO son tarea)
--   2. Consultas privadas de las alumnas a su docente (con respuestas)
--
-- CÓMO USARLO: Supabase > SQL Editor > New query, pega TODO este
-- archivo y dale Run una sola vez. Se puede volver a ejecutar sin daño.
-- Usa el mismo bucket privado "tareas-escolares" (carpeta lectura/).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. MATERIAL DE LECTURA
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.materiales (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  curso_id    uuid NOT NULL REFERENCES public.cursos(id) ON DELETE CASCADE,
  docente_id  uuid NOT NULL REFERENCES public.usuarios(id),
  titulo      varchar(200) NOT NULL,
  descripcion text,
  enlace      text CHECK (enlace IS NULL OR enlace ~* '^https?://'),
  creado_en   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_materiales_curso ON public.materiales(curso_id);

CREATE TABLE IF NOT EXISTS public.archivos_material (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  material_id    uuid NOT NULL REFERENCES public.materiales(id) ON DELETE CASCADE,
  nombre_archivo varchar(255) NOT NULL,
  ruta_storage   text NOT NULL UNIQUE,
  tipo_archivo   varchar(150),
  tamano_bytes   bigint CHECK (tamano_bytes IS NULL OR tamano_bytes <= 10485760),
  creado_en      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_archivos_material ON public.archivos_material(material_id);

CREATE OR REPLACE FUNCTION private.puede_ver_material(p_material uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.materiales m
                 WHERE m.id = p_material
                   AND (private.docente_del_curso(m.curso_id) OR private.alumna_del_curso(m.curso_id)));
$$;
CREATE OR REPLACE FUNCTION private.docente_de_material(p_material uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.materiales m
                 WHERE m.id = p_material AND private.docente_del_curso(m.curso_id));
$$;

ALTER TABLE public.materiales        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.archivos_material ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS materiales_ver ON public.materiales;
DROP POLICY IF EXISTS materiales_crear ON public.materiales;
DROP POLICY IF EXISTS materiales_editar ON public.materiales;
DROP POLICY IF EXISTS materiales_eliminar ON public.materiales;
CREATE POLICY materiales_ver ON public.materiales FOR SELECT TO authenticated
  USING (private.docente_del_curso(curso_id) OR private.alumna_del_curso(curso_id));
CREATE POLICY materiales_crear ON public.materiales FOR INSERT TO authenticated
  WITH CHECK (docente_id = (SELECT auth.uid()) AND private.docente_del_curso(curso_id));
CREATE POLICY materiales_editar ON public.materiales FOR UPDATE TO authenticated
  USING (private.docente_del_curso(curso_id)) WITH CHECK (private.docente_del_curso(curso_id));
CREATE POLICY materiales_eliminar ON public.materiales FOR DELETE TO authenticated
  USING (private.docente_del_curso(curso_id));

DROP POLICY IF EXISTS archivos_material_ver ON public.archivos_material;
DROP POLICY IF EXISTS archivos_material_crear ON public.archivos_material;
DROP POLICY IF EXISTS archivos_material_eliminar ON public.archivos_material;
CREATE POLICY archivos_material_ver ON public.archivos_material FOR SELECT TO authenticated
  USING (private.puede_ver_material(material_id));
CREATE POLICY archivos_material_crear ON public.archivos_material FOR INSERT TO authenticated
  WITH CHECK (private.docente_de_material(material_id)
              AND ruta_storage LIKE 'lectura/' || material_id::text || '/%');
CREATE POLICY archivos_material_eliminar ON public.archivos_material FOR DELETE TO authenticated
  USING (private.docente_de_material(material_id));

-- Archivos en Storage: lectura/<material_id>/archivo
DROP POLICY IF EXISTS storage_lectura_subir ON storage.objects;
DROP POLICY IF EXISTS storage_lectura_ver ON storage.objects;
DROP POLICY IF EXISTS storage_lectura_eliminar ON storage.objects;
CREATE POLICY storage_lectura_subir ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'tareas-escolares'
              AND (storage.foldername(name))[1] = 'lectura'
              AND EXISTS (SELECT 1 FROM public.materiales m
                          WHERE m.id::text = (storage.foldername(name))[2]
                            AND private.docente_del_curso(m.curso_id)));
CREATE POLICY storage_lectura_ver ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'tareas-escolares'
         AND (storage.foldername(name))[1] = 'lectura'
         AND EXISTS (SELECT 1 FROM public.materiales m
                     WHERE m.id::text = (storage.foldername(name))[2]
                       AND private.puede_ver_material(m.id)));
CREATE POLICY storage_lectura_eliminar ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'tareas-escolares'
         AND (storage.foldername(name))[1] = 'lectura'
         AND EXISTS (SELECT 1 FROM public.materiales m
                     WHERE m.id::text = (storage.foldername(name))[2]
                       AND private.docente_del_curso(m.curso_id)));

-- ---------------------------------------------------------------------
-- 2. CONSULTAS (solo las ven la alumna que pregunta y la docente del curso)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.consultas (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  curso_id       uuid NOT NULL REFERENCES public.cursos(id) ON DELETE CASCADE,
  alumna_id      uuid NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
  tarea_id       uuid REFERENCES public.tareas(id) ON DELETE SET NULL,
  asunto         varchar(200) NOT NULL,
  resuelta       boolean NOT NULL DEFAULT false,
  creado_en      timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_consultas_curso ON public.consultas(curso_id);
CREATE INDEX IF NOT EXISTS idx_consultas_alumna ON public.consultas(alumna_id);

CREATE TABLE IF NOT EXISTS public.consulta_mensajes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consulta_id uuid NOT NULL REFERENCES public.consultas(id) ON DELETE CASCADE,
  autor_id    uuid NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
  mensaje     text NOT NULL CHECK (length(trim(mensaje)) > 0 AND length(mensaje) <= 4000),
  creado_en   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_consulta_mensajes ON public.consulta_mensajes(consulta_id);

CREATE OR REPLACE FUNCTION private.puede_ver_consulta(p_consulta uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.consultas q
                 WHERE q.id = p_consulta
                   AND ((q.alumna_id = (SELECT auth.uid()) AND private.alumna_del_curso(q.curso_id))
                        OR private.docente_del_curso(q.curso_id)));
$$;

-- Cada mensaje nuevo mueve la consulta arriba; si escribe la alumna, se reabre
CREATE OR REPLACE FUNCTION private.tocar_consulta() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.consultas
     SET actualizado_en = now(),
         resuelta = CASE WHEN alumna_id = NEW.autor_id THEN false ELSE resuelta END
   WHERE id = NEW.consulta_id;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tocar_consulta_trigger ON public.consulta_mensajes;
CREATE TRIGGER tocar_consulta_trigger AFTER INSERT ON public.consulta_mensajes
  FOR EACH ROW EXECUTE FUNCTION private.tocar_consulta();
REVOKE ALL ON FUNCTION private.tocar_consulta() FROM PUBLIC, anon, authenticated;

ALTER TABLE public.consultas         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.consulta_mensajes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS consultas_ver ON public.consultas;
DROP POLICY IF EXISTS consultas_crear ON public.consultas;
DROP POLICY IF EXISTS consultas_editar ON public.consultas;
DROP POLICY IF EXISTS consultas_eliminar ON public.consultas;
CREATE POLICY consultas_ver ON public.consultas FOR SELECT TO authenticated
  USING ((alumna_id = (SELECT auth.uid()) AND private.alumna_del_curso(curso_id))
         OR private.docente_del_curso(curso_id));
CREATE POLICY consultas_crear ON public.consultas FOR INSERT TO authenticated
  WITH CHECK (alumna_id = (SELECT auth.uid())
              AND private.alumna_del_curso(curso_id)
              AND (tarea_id IS NULL OR EXISTS (SELECT 1 FROM public.tareas t
                                               WHERE t.id = tarea_id AND t.curso_id = consultas.curso_id)));
CREATE POLICY consultas_editar ON public.consultas FOR UPDATE TO authenticated
  USING (private.puede_ver_consulta(id)) WITH CHECK (private.puede_ver_consulta(id));
CREATE POLICY consultas_eliminar ON public.consultas FOR DELETE TO authenticated
  USING (private.docente_del_curso(curso_id)
         OR (alumna_id = (SELECT auth.uid())
             AND NOT EXISTS (SELECT 1 FROM public.consulta_mensajes m
                             WHERE m.consulta_id = consultas.id AND m.autor_id <> consultas.alumna_id)));

DROP POLICY IF EXISTS consulta_mensajes_ver ON public.consulta_mensajes;
DROP POLICY IF EXISTS consulta_mensajes_crear ON public.consulta_mensajes;
CREATE POLICY consulta_mensajes_ver ON public.consulta_mensajes FOR SELECT TO authenticated
  USING (private.puede_ver_consulta(consulta_id));
CREATE POLICY consulta_mensajes_crear ON public.consulta_mensajes FOR INSERT TO authenticated
  WITH CHECK (autor_id = (SELECT auth.uid()) AND private.puede_ver_consulta(consulta_id));

-- ---------------------------------------------------------------------
-- 3. PERMISOS
-- ---------------------------------------------------------------------
REVOKE ALL ON FUNCTION private.puede_ver_material(uuid)  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.docente_de_material(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.puede_ver_consulta(uuid)  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.puede_ver_material(uuid)  TO authenticated;
GRANT EXECUTE ON FUNCTION private.docente_de_material(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.puede_ver_consulta(uuid)  TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.materiales        TO authenticated;
GRANT SELECT, INSERT, DELETE         ON public.archivos_material TO authenticated;
GRANT SELECT, INSERT, DELETE         ON public.consultas         TO authenticated;
GRANT UPDATE (resuelta)              ON public.consultas         TO authenticated;
GRANT SELECT, INSERT                 ON public.consulta_mensajes TO authenticated;
