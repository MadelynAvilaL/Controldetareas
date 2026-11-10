-- =====================================================================
-- AulaNova · Migración v4: número de clave (lista) y foto de perfil
-- Ejecutar en Supabase > SQL Editor (una vez). Se puede repetir.
-- Después ejecuta asignar-claves.sql para poner el número de cada alumna.
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
