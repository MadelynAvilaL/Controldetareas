-- =====================================================================
-- VILLA DE LAS NIÑAS · MIGRACIÓN v9
-- Historial de búsquedas de las alumnas (sección "Buscar información").
--   · La alumna guarda y ve solo sus propias búsquedas.
--   · La docente ve (y puede borrar) las búsquedas de las alumnas
--     inscritas en sus cursos.
-- CÓMO USARLO: Supabase > SQL Editor > New query, pega TODO y dale Run.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.busquedas (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alumna_id uuid NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
  consulta  varchar(300) NOT NULL CHECK (length(trim(consulta)) > 0),
  tipo      varchar(20)  NOT NULL DEFAULT 'enciclopedia'
            CHECK (tipo IN ('enciclopedia', 'web', 'articulo')),
  creado_en timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_busquedas_alumna ON public.busquedas(alumna_id, creado_en DESC);

ALTER TABLE public.busquedas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS busquedas_ver ON public.busquedas;
DROP POLICY IF EXISTS busquedas_crear ON public.busquedas;
DROP POLICY IF EXISTS busquedas_eliminar ON public.busquedas;
CREATE POLICY busquedas_ver ON public.busquedas FOR SELECT TO authenticated
  USING (alumna_id = (SELECT auth.uid()) OR private.puede_ver_alumna(alumna_id));
CREATE POLICY busquedas_crear ON public.busquedas FOR INSERT TO authenticated
  WITH CHECK (alumna_id = (SELECT auth.uid()) AND private.es_alumna());
CREATE POLICY busquedas_eliminar ON public.busquedas FOR DELETE TO authenticated
  USING (private.puede_ver_alumna(alumna_id));

GRANT SELECT, INSERT, DELETE ON public.busquedas TO authenticated;
