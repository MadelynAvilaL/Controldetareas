-- Corrección para la política INSERT de entregas del script anterior.
-- El registro de la nueva entrega no se debe usar para consultar
-- calificaciones antes de que exista.
DROP POLICY IF EXISTS entregas_crear ON public.entregas;
CREATE POLICY entregas_crear
ON public.entregas FOR INSERT TO authenticated
WITH CHECK (
  alumna_id = (SELECT auth.uid())
  AND private.puede_entregar(tarea_id)
);
-- El CHECK de entregas de la primera versión era redundante.
ALTER TABLE public.entregas DROP CONSTRAINT IF EXISTS entregas_check;
-- Limitar los nuevos archivos del bucket a 10 MB. Conservar bucket privado.
UPDATE storage.buckets
SET file_size_limit = 10485760,
    allowed_mime_types = ARRAY[
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'image/png','image/jpeg','text/plain',
      'application/zip','application/x-zip-compressed'
    ]
WHERE id = 'tareas-escolares';
