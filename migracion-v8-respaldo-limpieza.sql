-- =====================================================================
-- VILLA DE LAS NIÑAS · MIGRACIÓN v8
-- Respaldo en Excel y limpieza de datos de un curso (fin de ciclo).
--
-- Ejecuta ANTES migracion-v7-material-consultas.sql.
-- CÓMO USARLO: Supabase > SQL Editor > New query, pega TODO y dale Run.
-- Se puede volver a ejecutar sin daño.
-- =====================================================================

-- 1. La docente puede borrar del Storage los archivos que sus alumnas
--    entregaron en SUS cursos (antes solo podía la alumna).
DROP POLICY IF EXISTS storage_tareas_eliminar_docente ON storage.objects;
CREATE POLICY storage_tareas_eliminar_docente ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'tareas-escolares'
         AND EXISTS (SELECT 1 FROM public.entregas e
                     WHERE e.id::text = (storage.foldername(name))[2]
                       AND private.docente_de_entrega(e.id)));

-- 2. Vaciar un curso. Nunca borra el curso, ni las cuentas de las alumnas.
--    Cada parámetro indica qué se borra. Devuelve cuántas filas se borraron.
CREATE OR REPLACE FUNCTION public.vaciar_curso(
  p_curso       uuid,
  p_entregas    boolean DEFAULT true,   -- entregas, archivos y calificaciones
  p_tareas      boolean DEFAULT false,  -- tareas (y con ellas sus entregas)
  p_consultas   boolean DEFAULT false,
  p_material    boolean DEFAULT false,
  p_avisos      boolean DEFAULT false,
  p_grupos      boolean DEFAULT false,
  p_alumnas     boolean DEFAULT false   -- quitar inscripciones (las cuentas se conservan)
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r jsonb := '{}'::jsonb;
  n integer;
BEGIN
  IF NOT private.docente_del_curso(p_curso) THEN
    RAISE EXCEPTION 'Solo la docente del curso puede vaciarlo.';
  END IF;

  IF p_entregas OR p_tareas THEN
    DELETE FROM public.entregas e USING public.tareas t
     WHERE e.tarea_id = t.id AND t.curso_id = p_curso;
    GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('entregas', n);
  END IF;
  IF p_tareas THEN
    DELETE FROM public.tareas WHERE curso_id = p_curso;
    GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('tareas', n);
  END IF;
  IF p_consultas THEN
    DELETE FROM public.consultas WHERE curso_id = p_curso;
    GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('consultas', n);
  END IF;
  IF p_material THEN
    DELETE FROM public.materiales WHERE curso_id = p_curso;
    GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('material', n);
  END IF;
  IF p_avisos THEN
    DELETE FROM public.anuncios WHERE curso_id = p_curso;
    GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('avisos', n);
  END IF;
  IF p_grupos OR p_alumnas THEN
    DELETE FROM public.grupos WHERE curso_id = p_curso;
    GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('grupos', n);
  END IF;
  IF p_alumnas THEN
    DELETE FROM public.inscripciones WHERE curso_id = p_curso;
    GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('inscripciones', n);
  END IF;
  RETURN r;
END $$;

REVOKE ALL ON FUNCTION public.vaciar_curso(uuid, boolean, boolean, boolean, boolean, boolean, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vaciar_curso(uuid, boolean, boolean, boolean, boolean, boolean, boolean, boolean) TO authenticated;
