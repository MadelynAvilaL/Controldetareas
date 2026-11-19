-- =====================================================================
-- VILLA DE LAS NIÑAS · Permitir archivos de Access (.accdb, .mdb)
-- en entregas, material de tareas y material de lectura.
-- Mantiene Word, PowerPoint, Excel, PDF, imágenes, texto y ZIP.
--
-- CÓMO USARLO: Supabase > SQL Editor > New query, pega TODO y dale Run.
-- Vuelve a ejecutarlo si después corres otro script que modifique el
-- bucket "tareas-escolares" (por ejemplo permitir-powerpoint.sql).
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
  -- Access
  'application/vnd.ms-access', 'application/msaccess', 'application/x-msaccess',
  'application/x-ms-access',
  -- Imágenes, texto y comprimidos
  'image/png', 'image/jpeg', 'text/plain',
  'application/zip', 'application/x-zip-compressed',
  -- Respaldo: algunos navegadores envían Access como binario genérico.
  -- La plataforma solo deja elegir las extensiones permitidas.
  'application/octet-stream'
])
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Comprobar: las dos columnas deben salir true
SELECT 'application/vnd.ms-access' = ANY (allowed_mime_types) AS access_permitido,
       file_size_limit = 10485760                              AS limite_10mb
FROM storage.buckets WHERE id = 'tareas-escolares';
