-- =====================================================================
-- AulaNova · Migración v6: las alumnas eligen su grupo
-- Ejecutar en Supabase > SQL Editor DESPUÉS de migracion-v5.
-- Se puede ejecutar más de una vez.
-- =====================================================================

-- 1. Configuración por curso (la docente la cambia desde la app)
ALTER TABLE public.cursos ADD COLUMN IF NOT EXISTS grupos_abiertos boolean NOT NULL DEFAULT false;
ALTER TABLE public.cursos ADD COLUMN IF NOT EXISTS max_por_grupo integer NOT NULL DEFAULT 5;
ALTER TABLE public.cursos DROP CONSTRAINT IF EXISTS cursos_max_por_grupo_check;
ALTER TABLE public.cursos ADD CONSTRAINT cursos_max_por_grupo_check CHECK (max_por_grupo BETWEEN 1 AND 50);

-- 2. Para elegir por afinidad, la alumna ve los nombres de sus compañeras
--    de curso (las fotos siguen siendo privadas).
CREATE OR REPLACE FUNCTION private.comparte_curso(p_alumna uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.es_alumna() AND EXISTS (
    SELECT 1 FROM public.inscripciones a
    JOIN public.inscripciones b ON b.curso_id = a.curso_id
    WHERE a.alumna_id = (SELECT auth.uid()) AND b.alumna_id = p_alumna);
$$;
REVOKE ALL ON FUNCTION private.comparte_curso(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.comparte_curso(uuid) TO authenticated;

DROP POLICY IF EXISTS usuarios_ver_companeras_curso ON public.usuarios;
CREATE POLICY usuarios_ver_companeras_curso ON public.usuarios FOR SELECT TO authenticated
  USING (private.comparte_curso(id));

-- 3. Funciones que usa la alumna
-- Revisa que la alumna esté en el curso y que la elección esté abierta
CREATE OR REPLACE FUNCTION private.validar_eleccion_grupo(p_curso uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT private.alumna_del_curso(p_curso) THEN
    RAISE EXCEPTION 'No estás inscrita en este curso';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cursos WHERE id = p_curso AND grupos_abiertos AND activo) THEN
    RAISE EXCEPTION 'Tu docente todavía no ha abierto la elección de grupos en este curso';
  END IF;
END $$;

-- Sale de su grupo actual en ese curso (y borra el grupo si queda vacío)
CREATE OR REPLACE FUNCTION private.quitar_de_grupo(p_curso uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_grupo uuid;
BEGIN
  DELETE FROM public.grupo_integrantes
  WHERE curso_id = p_curso AND alumna_id = (SELECT auth.uid())
  RETURNING grupo_id INTO v_grupo;
  IF v_grupo IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.grupo_integrantes WHERE grupo_id = v_grupo) THEN
    DELETE FROM public.grupos WHERE id = v_grupo;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.unirse_a_grupo(p_grupo uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_curso uuid; v_max integer; v_n integer;
BEGIN
  SELECT g.curso_id, c.max_por_grupo INTO v_curso, v_max
  FROM public.grupos g JOIN public.cursos c ON c.id = g.curso_id WHERE g.id = p_grupo;
  IF v_curso IS NULL THEN RAISE EXCEPTION 'Ese grupo ya no existe'; END IF;
  PERFORM private.validar_eleccion_grupo(v_curso);
  IF EXISTS (SELECT 1 FROM public.grupo_integrantes WHERE grupo_id = p_grupo AND alumna_id = (SELECT auth.uid())) THEN
    RETURN;  -- ya está en ese grupo
  END IF;
  PERFORM 1 FROM public.grupos WHERE id = p_grupo FOR UPDATE;  -- evita que dos entren al último lugar
  SELECT count(*) INTO v_n FROM public.grupo_integrantes WHERE grupo_id = p_grupo;
  IF v_n >= v_max THEN RAISE EXCEPTION 'Ese grupo ya está lleno (máximo %)', v_max; END IF;
  PERFORM private.quitar_de_grupo(v_curso);
  INSERT INTO public.grupo_integrantes (grupo_id, alumna_id) VALUES (p_grupo, (SELECT auth.uid()));
END $$;

CREATE OR REPLACE FUNCTION public.crear_grupo_alumna(p_curso uuid, p_nombre text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid; v_nombre text := left(trim(p_nombre), 100);
BEGIN
  PERFORM private.validar_eleccion_grupo(p_curso);
  IF v_nombre IS NULL OR v_nombre = '' THEN RAISE EXCEPTION 'Escribe un nombre para el grupo'; END IF;
  IF EXISTS (SELECT 1 FROM public.grupos WHERE curso_id = p_curso AND lower(nombre) = lower(v_nombre)) THEN
    RAISE EXCEPTION 'Ya existe un grupo con ese nombre';
  END IF;
  PERFORM private.quitar_de_grupo(p_curso);
  INSERT INTO public.grupos (curso_id, nombre) VALUES (p_curso, v_nombre) RETURNING id INTO v_id;
  INSERT INTO public.grupo_integrantes (grupo_id, alumna_id) VALUES (v_id, (SELECT auth.uid()));
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.salir_de_grupo(p_curso uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM private.validar_eleccion_grupo(p_curso);
  PERFORM private.quitar_de_grupo(p_curso);
END $$;

REVOKE ALL ON FUNCTION private.validar_eleccion_grupo(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.quitar_de_grupo(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.unirse_a_grupo(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.crear_grupo_alumna(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.salir_de_grupo(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unirse_a_grupo(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.crear_grupo_alumna(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.salir_de_grupo(uuid) TO authenticated;
