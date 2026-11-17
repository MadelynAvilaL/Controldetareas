-- =====================================================================
-- AulaNova · Permitir archivos de Access (.accdb, .mdb) en entregas y
-- material de tareas. Mantiene Word, PowerPoint, Excel, PDF, imágenes,
-- texto y ZIP. Ejecutar en Supabase > SQL Editor.
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
  'application/vnd.ms-access', 'application/msaccess', 'application/x-msaccess',
  'image/png', 'image/jpeg', 'text/plain',
  'application/zip', 'application/x-zip-compressed'
])
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Comprobar (debe salir true)
SELECT 'application/vnd.ms-access' = ANY (allowed_mime_types) AS access_permitido
FROM storage.buckets WHERE id = 'tareas-escolares';
