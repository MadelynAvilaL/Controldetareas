-- =====================================================================
-- AulaNova · Migración v2 (estilo Classroom, sin correo para alumnas)
-- Ejecutar en Supabase > SQL Editor DESPUÉS del script original y de
-- ajuste-sql.sql. Se puede ejecutar por bloques.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. EVITAR DUPLICADOS (obligatorio)
--    El código asume UNA entrega por alumna y tarea, pero la tabla
--    permite varias. Lo mismo con inscripciones.
--    Si falla, primero borra los duplicados que ya existan.
-- ---------------------------------------------------------------------
ALTER TABLE public.entregas
  ADD CONSTRAINT entregas_tarea_alumna_unica UNIQUE (tarea_id, alumna_id);

ALTER TABLE public.inscripciones
  ADD CONSTRAINT inscripciones_curso_alumna_unica UNIQUE (curso_id, alumna_id);

-- ---------------------------------------------------------------------
-- 2. BORRADO EN CASCADA (recomendado)
--    Sin esto no se puede borrar una tarea o un curso que ya tenga
--    entregas. (No se toca usuarios: a una alumna se le desactiva con
--    activo = false, no se borra.)
-- ---------------------------------------------------------------------
ALTER TABLE public.inscripciones DROP CONSTRAINT inscripciones_curso_id_fkey,
  ADD CONSTRAINT inscripciones_curso_id_fkey FOREIGN KEY (curso_id)
  REFERENCES public.cursos(id) ON DELETE CASCADE;

ALTER TABLE public.tareas DROP CONSTRAINT tareas_curso_id_fkey,
  ADD CONSTRAINT tareas_curso_id_fkey FOREIGN KEY (curso_id)
  REFERENCES public.cursos(id) ON DELETE CASCADE;

ALTER TABLE public.anuncios DROP CONSTRAINT anuncios_curso_id_fkey,
  ADD CONSTRAINT anuncios_curso_id_fkey FOREIGN KEY (curso_id)
  REFERENCES public.cursos(id) ON DELETE CASCADE;

ALTER TABLE public.entregas DROP CONSTRAINT entregas_tarea_id_fkey,
  ADD CONSTRAINT entregas_tarea_id_fkey FOREIGN KEY (tarea_id)
  REFERENCES public.tareas(id) ON DELETE CASCADE;

ALTER TABLE public.archivos_entrega DROP CONSTRAINT archivos_entrega_entrega_id_fkey,
  ADD CONSTRAINT archivos_entrega_entrega_id_fkey FOREIGN KEY (entrega_id)
  REFERENCES public.entregas(id) ON DELETE CASCADE;

ALTER TABLE public.calificaciones DROP CONSTRAINT calificaciones_entrega_id_fkey,
  ADD CONSTRAINT calificaciones_entrega_id_fkey FOREIGN KEY (entrega_id)
  REFERENCES public.entregas(id) ON DELETE CASCADE;
-- Nota: borrar filas no borra los archivos del bucket de Storage.

-- ---------------------------------------------------------------------
-- 3. NOTA NO PUEDE SUPERAR LOS PUNTOS DE LA TAREA (obligatorio)
--    Hoy solo lo valida el navegador (input max), se puede saltar.
-- ---------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS private;

CREATE OR REPLACE FUNCTION private.validar_nota()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_max numeric;
BEGIN
  SELECT t.puntos_maximos INTO v_max
  FROM public.entregas e JOIN public.tareas t ON t.id = e.tarea_id
  WHERE e.id = NEW.entrega_id;
  IF v_max IS NULL THEN RAISE EXCEPTION 'Entrega no encontrada'; END IF;
  IF NEW.nota > v_max THEN
    RAISE EXCEPTION 'La nota (%) supera el máximo de la tarea (%)', NEW.nota, v_max;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS calificaciones_validar_nota ON public.calificaciones;
CREATE TRIGGER calificaciones_validar_nota
  BEFORE INSERT OR UPDATE OF nota, entrega_id ON public.calificaciones
  FOR EACH ROW EXECUTE FUNCTION private.validar_nota();

-- ---------------------------------------------------------------------
-- 4. FECHA DE ÚLTIMA ACTUALIZACIÓN DE LA ENTREGA (recomendado)
--    Al "Actualizar" una entrega, fecha_entrega no cambia; así la
--    docente sabe si la alumna modificó su trabajo y cuándo.
-- ---------------------------------------------------------------------
ALTER TABLE public.entregas
  ADD COLUMN IF NOT EXISTS actualizado_en timestamptz NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION private.tocar_actualizado_en()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN NEW.actualizado_en := now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS entregas_actualizado_en ON public.entregas;
CREATE TRIGGER entregas_actualizado_en
  BEFORE UPDATE ON public.entregas
  FOR EACH ROW EXECUTE FUNCTION private.tocar_actualizado_en();

-- ---------------------------------------------------------------------
-- 5. CÓDIGO DE CLASE, como en Classroom (para unirse sin que la
--    docente inscriba a mano). Requiere el botón "Unirme a una clase"
--    en el frontend.
-- ---------------------------------------------------------------------
ALTER TABLE public.cursos
  ADD COLUMN IF NOT EXISTS codigo_clase varchar(7) UNIQUE
  DEFAULT upper(substr(md5(gen_random_uuid()::text), 1, 7));

CREATE OR REPLACE FUNCTION public.unirse_a_curso(p_codigo text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_curso uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.usuarios
                 WHERE id = auth.uid() AND rol = 'alumna' AND activo) THEN
    RAISE EXCEPTION 'Solo una alumna activa puede unirse a una clase';
  END IF;
  SELECT id INTO v_curso FROM public.cursos
  WHERE codigo_clase = upper(trim(p_codigo)) AND activo;
  IF v_curso IS NULL THEN RAISE EXCEPTION 'Código de clase no válido'; END IF;
  INSERT INTO public.inscripciones (curso_id, alumna_id)
  VALUES (v_curso, auth.uid())
  ON CONFLICT (curso_id, alumna_id) DO NOTHING;
  RETURN v_curso;
END $$;

REVOKE ALL ON FUNCTION public.unirse_a_curso(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.unirse_a_curso(text) TO authenticated;

-- ---------------------------------------------------------------------
-- 6. PERFIL AUTOMÁTICO AL CREAR LA CUENTA (recomendado)
--    Al crear en Authentication > Add user el email
--    maria.lopez@alumnas.invalid (con "Auto confirm"), se crea solo su
--    fila en public.usuarios. Luego solo corriges nombre/apellido.
--    Siempre se crea como 'alumna'; a docentes se les cambia el rol a
--    mano. IMPORTANTE: desactiva "Allow new users to sign up" en
--    Authentication > Sign In / Providers para que nadie se registre
--    por su cuenta con la clave pública.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.crear_perfil()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_usuario text := lower(split_part(NEW.email, '@', 1));
BEGIN
  IF NEW.email NOT ILIKE '%@alumnas.invalid' THEN RETURN NEW; END IF;
  INSERT INTO public.usuarios (id, usuario, nombre, apellido, rol)
  VALUES (
    NEW.id,
    v_usuario,
    coalesce(NEW.raw_user_meta_data->>'nombre', v_usuario),
    coalesce(NEW.raw_user_meta_data->>'apellido', '-'),
    'alumna'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS al_crear_usuario ON auth.users;
CREATE TRIGGER al_crear_usuario
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION private.crear_perfil();

-- ---------------------------------------------------------------------
-- 7. ÍNDICES (rendimiento; las FK no crean índice solas)
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_cursos_docente      ON public.cursos (docente_id);
CREATE INDEX IF NOT EXISTS idx_inscripciones_alumna ON public.inscripciones (alumna_id);
CREATE INDEX IF NOT EXISTS idx_tareas_curso        ON public.tareas (curso_id);
CREATE INDEX IF NOT EXISTS idx_anuncios_curso      ON public.anuncios (curso_id);
CREATE INDEX IF NOT EXISTS idx_entregas_alumna     ON public.entregas (alumna_id);
CREATE INDEX IF NOT EXISTS idx_archivos_entrega    ON public.archivos_entrega (entrega_id);
