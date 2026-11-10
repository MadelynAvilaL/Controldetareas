-- =====================================================================
-- AulaNova · Poner el grado y la sección como nombre de cada curso
-- Ejemplo: "Computación · SEGUNDO · A"  →  "Segundo Básico A"
-- La materia (Computación) queda en la descripción.
-- Ejecutar en Supabase > SQL Editor.
-- =====================================================================

-- 1. Vista previa (no cambia nada): revisa cómo quedarían los nombres
SELECT nombre AS nombre_actual,
       initcap(lower(trim(grado))) || ' Básico ' || upper(trim(seccion)) AS nombre_nuevo,
       codigo_clase
FROM public.cursos
WHERE activo
ORDER BY grado, seccion;

-- 2. Cambiar los nombres de Segundo y Tercero
UPDATE public.cursos
SET grado       = initcap(lower(trim(grado))) || ' Básico',
    seccion     = upper(trim(seccion)),
    nombre      = initcap(lower(trim(grado))) || ' Básico ' || upper(trim(seccion)),
    descripcion = 'Computación'
WHERE activo
  AND lower(trim(grado)) IN ('segundo', 'tercero');

-- 3. (Opcional) Archivar el curso de prueba "Cuarto A".
--    No se borra nada; solo deja de aparecer. Quita los dos guiones
--    del inicio de la línea siguiente para ejecutarlo.
-- UPDATE public.cursos SET activo = false WHERE codigo_clase = '7B9904B';

-- 4. Comprobar
SELECT nombre, grado, seccion, descripcion, codigo_clase
FROM public.cursos WHERE activo ORDER BY nombre;
