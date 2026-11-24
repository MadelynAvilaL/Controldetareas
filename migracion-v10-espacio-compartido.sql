-- =====================================================================
-- AulaNova · Migración v10: espacio compartido por curso (tipo chat)
-- Las alumnas de un curso comparten mensajes, documentos y enlaces
-- SOLO cuando la docente abre el espacio de ese curso.
-- Cerrado (lo normal): las alumnas no ven ni pueden subir nada.
-- La docente siempre lo ve todo, puede escribir y puede borrar.
-- Ejecutar en Supabase > SQL Editor DESPUÉS de la v6. Se puede repetir.
-- =====================================================================

-- 1. Interruptor por curso (empieza cerrado)
ALTER TABLE public.cursos ADD COLUMN IF NOT EXISTS compartir_abierto boolean NOT NULL DEFAULT false;

-- 2. Mensajes del espacio compartido (texto, archivo y/o enlace)
CREATE TABLE IF NOT EXISTS public.compartidos (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  curso_id       uuid NOT NULL REFERENCES public.cursos(id) ON DELETE CASCADE,
  autor_id       uuid NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
  texto          text CHECK (char_length(texto) <= 4000),
  enlace         text CHECK (enlace IS NULL OR enlace ~* '^https?://'),
  nombre_archivo text,
  ruta_storage   text UNIQUE,
  tipo_archivo   text,
  tamano_bytes   bigint CHECK (tamano_bytes >= 0),
  creado_en      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compartidos_algo CHECK (nullif(trim(texto), '') IS NOT NULL OR ruta_storage IS NOT NULL OR enlace IS NOT NULL),
  CONSTRAINT compartidos_ruta CHECK (ruta_storage IS NULL OR ruta_storage LIKE curso_id::text || '/' || autor_id::text || '/%')
);
CREATE INDEX IF NOT EXISTS idx_compartidos_curso ON public.compartidos (curso_id, creado_en DESC);

-- 3. ¿Quién puede ver / escribir?
CREATE OR REPLACE FUNCTION private.compartir_abierto(p_curso uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.cursos WHERE id = p_curso AND compartir_abierto AND activo);
$$;
CREATE OR REPLACE FUNCTION private.puede_ver_compartido(p_curso uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.docente_del_curso(p_curso)
      OR (private.alumna_del_curso(p_curso) AND private.compartir_abierto(p_curso));
$$;
REVOKE ALL ON FUNCTION private.compartir_abierto(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.puede_ver_compartido(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.compartir_abierto(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.puede_ver_compartido(uuid) TO authenticated;

ALTER TABLE public.compartidos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.compartidos FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.compartidos TO authenticated;

DROP POLICY IF EXISTS compartidos_ver ON public.compartidos;
CREATE POLICY compartidos_ver ON public.compartidos FOR SELECT TO authenticated
  USING (private.puede_ver_compartido(curso_id));

DROP POLICY IF EXISTS compartidos_crear ON public.compartidos;
CREATE POLICY compartidos_crear ON public.compartidos FOR INSERT TO authenticated
  WITH CHECK (autor_id = (SELECT auth.uid()) AND private.puede_ver_compartido(curso_id));

-- La docente borra cualquier mensaje; la alumna solo los suyos y con el espacio abierto
DROP POLICY IF EXISTS compartidos_eliminar ON public.compartidos;
CREATE POLICY compartidos_eliminar ON public.compartidos FOR DELETE TO authenticated
  USING (private.docente_del_curso(curso_id)
         OR (autor_id = (SELECT auth.uid()) AND private.puede_ver_compartido(curso_id)));

-- 4. Archivos (Storage: compartidos/<curso_id>/<autor_id>/archivo)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('compartidos', 'compartidos', false, 20971520, ARRAY[
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
  SET public = false, file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS storage_compartidos_subir ON storage.objects;
CREATE POLICY storage_compartidos_subir ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'compartidos'
    AND (storage.foldername(name))[2] = (SELECT auth.uid())::text
    AND EXISTS (SELECT 1 FROM public.cursos c
                WHERE c.id::text = (storage.foldername(name))[1]
                  AND private.puede_ver_compartido(c.id)));

DROP POLICY IF EXISTS storage_compartidos_ver ON storage.objects;
CREATE POLICY storage_compartidos_ver ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'compartidos'
    AND EXISTS (SELECT 1 FROM public.cursos c
                WHERE c.id::text = (storage.foldername(name))[1]
                  AND private.puede_ver_compartido(c.id)));

DROP POLICY IF EXISTS storage_compartidos_eliminar ON storage.objects;
CREATE POLICY storage_compartidos_eliminar ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'compartidos'
    AND EXISTS (SELECT 1 FROM public.cursos c
                WHERE c.id::text = (storage.foldername(name))[1]
                  AND (private.docente_del_curso(c.id)
                       OR ((storage.foldername(name))[2] = (SELECT auth.uid())::text
                           AND private.puede_ver_compartido(c.id)))));
