-- =====================================================================
-- AulaNova · Subir el límite a 20 MB por archivo
-- (entregas, material de tareas, material de lectura y espacio compartido)
-- Ejecutar en Supabase > SQL Editor.
-- =====================================================================
UPDATE storage.buckets
SET file_size_limit = 20971520   -- 20 MB
WHERE id IN ('tareas-escolares', 'compartidos');

-- Comprobar: deben salir 20 MB
SELECT id, pg_size_pretty(file_size_limit::bigint) AS limite
FROM storage.buckets
WHERE id IN ('tareas-escolares', 'compartidos');
