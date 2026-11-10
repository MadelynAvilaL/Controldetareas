-- =====================================================================
-- AulaNova · Permitir PowerPoint (.ppt, .pptx) y Excel (.xls, .xlsx)
-- en entregas y material de tareas. Ejecutar en Supabase > SQL Editor.
-- =====================================================================
UPDATE storage.buckets
SET file_size_limit = 10485760,   -- 10 MB por archivo
    allowed_mime_types = ARRAY[
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'image/png', 'image/jpeg', 'text/plain',
      'application/zip', 'application/x-zip-compressed'
    ]
WHERE id = 'tareas-escolares';

SELECT id, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = 'tareas-escolares';
