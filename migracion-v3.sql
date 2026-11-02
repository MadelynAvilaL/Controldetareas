-- =====================================================================
-- AulaNova · Migración v3: material de tareas, inscripción por usuario
-- y eliminar tareas.
-- Ejecutar en Supabase > SQL Editor DESPUÉS de migracion-classroom.sql.
-- Se puede ejecutar más de una vez sin problema.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Función auxiliar: ¿puede el usuario actual ver esta tarea?
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.puede_ver_tarea(p_tarea uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.tareas t
    WHERE t.id = p_tarea
      AND (private.docente_del_curso(t.curso_id)
           OR (t.publicada AND private.alumna_del_curso(t.curso_id)))
  );
$$;
REVOKE ALL ON FUNCTION private.puede_ver_tarea(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.puede_ver_tarea(uuid) TO authenticated;

-- ---------------------------------------------------------------------
-- 2. MATERIAL DE LA TAREA (archivos que adjunta la docente)
--    Ruta en Storage: material/<tarea_id>/<archivo>
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.archivos_tarea (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tarea_id uuid NOT NULL REFERENCES public.tareas(id) ON DELETE CASCADE,
  nombre_archivo text NOT NULL,
  ruta_storage text NOT NULL UNIQUE,
  tipo_archivo text,
  tamano_bytes bigint CHECK (tamano_bytes >= 0),
  creado_en timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT archivos_tarea_ruta
    CHECK (ruta_storage LIKE 'material/' || tarea_id::text || '/%')
);
CREATE INDEX IF NOT EXISTS idx_archivos_tarea ON public.archivos_tarea (tarea_id);

ALTER TABLE public.archivos_tarea ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.archivos_tarea FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.archivos_tarea TO authenticated;

DROP POLICY IF EXISTS archivos_tarea_ver ON public.archivos_tarea;
CREATE POLICY archivos_tarea_ver ON public.archivos_tarea
  FOR SELECT TO authenticated
  USING (private.puede_ver_tarea(tarea_id));

DROP POLICY IF EXISTS archivos_tarea_crear ON public.archivos_tarea;
CREATE POLICY archivos_tarea_crear ON public.archivos_tarea
  FOR INSERT TO authenticated
  WITH CHECK (private.docente_de_tarea(tarea_id));

DROP POLICY IF EXISTS archivos_tarea_eliminar ON public.archivos_tarea;
CREATE POLICY archivos_tarea_eliminar ON public.archivos_tarea
  FOR DELETE TO authenticated
  USING (private.docente_de_tarea(tarea_id));

-- Storage: la docente sube/borra material; alumnas del curso lo descargan.
DROP POLICY IF EXISTS storage_material_subir ON storage.objects;
CREATE POLICY storage_material_subir ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'tareas-escolares'
    AND (storage.foldername(name))[1] = 'material'
    AND EXISTS (SELECT 1 FROM public.tareas t
                WHERE t.id::text = (storage.foldername(name))[2]
                  AND private.docente_de_tarea(t.id))
  );

DROP POLICY IF EXISTS storage_material_ver ON storage.objects;
CREATE POLICY storage_material_ver ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'tareas-escolares'
    AND (storage.foldername(name))[1] = 'material'
    AND EXISTS (SELECT 1 FROM public.tareas t
                WHERE t.id::text = (storage.foldername(name))[2]
                  AND private.puede_ver_tarea(t.id))
  );

DROP POLICY IF EXISTS storage_material_eliminar ON storage.objects;
CREATE POLICY storage_material_eliminar ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'tareas-escolares'
    AND (storage.foldername(name))[1] = 'material'
    AND EXISTS (SELECT 1 FROM public.tareas t
                WHERE t.id::text = (storage.foldername(name))[2]
                  AND private.docente_de_tarea(t.id))
  );

-- ---------------------------------------------------------------------
-- 3. INSCRIBIR ALUMNA POR NOMBRE DE USUARIO (lo hace la docente)
--    Hace falta una función porque la docente no puede ver a alumnas
--    que aún no están en sus cursos.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.inscribir_alumna(p_curso uuid, p_usuario text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
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
REVOKE ALL ON FUNCTION public.inscribir_alumna(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inscribir_alumna(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------
-- 4. LA DOCENTE PUEDE ELIMINAR SUS TAREAS
--    (se borran también sus entregas, notas y registros de archivos)
-- ---------------------------------------------------------------------
GRANT DELETE ON public.tareas TO authenticated;
DROP POLICY IF EXISTS tareas_eliminar ON public.tareas;
CREATE POLICY tareas_eliminar ON public.tareas
  FOR DELETE TO authenticated
  USING (private.docente_del_curso(curso_id));

-- ---------------------------------------------------------------------
-- 5. LA DOCENTE VE SUS CURSOS DIRECTAMENTE
--    Necesario para que, al crear un curso, la app reciba el curso
--    recién creado (y su código de clase) en la misma operación.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS cursos_ver_propios ON public.cursos;
CREATE POLICY cursos_ver_propios ON public.cursos
  FOR SELECT TO authenticated
  USING (docente_id = (SELECT auth.uid()));
