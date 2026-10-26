# AulaNova — plataforma de tareas escolares

Proyecto HTML + CSS + JavaScript + Bootstrap 5 + Supabase.

## Estructura

- `index.html`: interfaz de inicio de sesión, panel y ventanas emergentes.
- `css/styles.css`: diseño personalizado y responsive.
- `js/config.js`: URL pública y clave pública del proyecto Supabase.
- `js/app.js`: autenticación, consultas y formularios.

## Instalación

1. Crea el proyecto de Supabase y ejecuta el script SQL de la conversación (después ejecuta `ajuste-sql.sql` para corregir la política de entregas y establecer límites para adjuntos).
2. En **Project Settings / API** (o **Connect**), copia la **Project URL** y la clave **publishable** o **anon** (NO `service_role`, NO `secret`). Colócalas en `js/config.js`.
3. Crea en Supabase Auth las cuentas de ejemplo desde un entorno administrativo seguro. Para el nombre `maria.lopez`, el email técnico será exactamente `maria.lopez@alumnas.invalid`. Establece una contraseña, marca el email como confirmado al aprovisionar la cuenta y luego inserta la fila de `public.usuarios` con `id` igual al UUID de Auth, `usuario='maria.lopez'`, el nombre/apellido y `rol='alumna'`. **No ejecutes altas administrativas con claves secretas en el navegador.**
4. Para docentes se aplica la misma regla (`docente1@alumnas.invalid`) aunque el dominio sea simbólico. Crea un perfil con `rol='docente'` y cursos cuyo `docente_id` sea su UUID. Inscribe alumnas en `inscripciones`.
5. Abre con VS Code > Live Server. Evita abrir `index.html` mediante `file://` porque usa módulos JavaScript. Para publicar, sube la carpeta a GitHub y activa Settings > Pages > Deploy from a branch > main / root.
6. Revisa en Supabase Auth > URL Configuration los orígenes de tu despliegue si usas flujos que requieren redirección. Esta versión usa contraseña, no correos de confirmación.

## Bootstrap

Se importa desde CDN en `index.html`, con una etiqueta `<link>` dentro de `<head>` para los estilos y `<script>` al final para los modales. No hay que descargar Bootstrap ni instalar npm. Se combina con `css/styles.css`; esta última hoja viene después para sobrescribir colores y bordes. También se incluye Bootstrap Icons por CDN.

## Funcionalidad

- Inicio de sesión con usuario y contraseña (se transforma internamente el usuario a un email técnico fijo para Supabase Auth).
- Panel de cursos, tareas, avisos, y estadísticas básicas.
- Docente: crear tareas, revisar entregas, abrir adjuntos y calificar.
- Alumna: consultar tareas, enviar/actualizar texto, URL y archivo, consultar su nota.
- Panel adaptado a móvil.

## Seguridad y límites de esta versión

- El dominio `.invalid` es un identificador técnico **no entregable**; no recibe mensajes ni sirve para recuperar contraseñas. El administrador tiene que crear/reestablecer cuentas de manera segura.
- No coloques claves `service_role` ni `secret` en frontend/GitHub. `js/config.js` contiene únicamente claves públicas, protegidas mediante RLS.
- Supabase no permite iniciar sesión por nombre de usuario de forma nativa: la transformación de nombre a email técnico requiere que las cuentas de Auth hayan sido provisionadas con esa misma convención.
- Se requiere revisar/corregir el script de RLS original si se producen errores de política SQL. En particular, la política de INSERT de entregas del script anterior no debe intentar consultar `entregas.id` desde su `WITH CHECK`, y el código solo podrá funcionar si las funciones auxiliares de autorización existen y los perfiles coinciden con Auth.
- No está implementado el alta de usuarios, inscripción a cursos, edición de cursos, publicación de avisos o flujo de recuperación de contraseña desde interfaz. El administrador puede preparar estos registros de forma segura en Supabase.
- En la entrega de archivos se permite adjuntar un archivo por envío; se usa una carpeta privada `tareas-escolares` protegida por Storage RLS. Los enlaces firmados duran 5 minutos.
- Prueba la seguridad con usuarios de rol diferente antes de usar datos reales de alumnas. Considera limitar los tipos y tamaños de archivos también en la configuración del bucket.
- El total de tareas sin entregar mostrado en la vista estudiantil incluye actividades vencidas; para métricas exactas a gran escala se recomendaría una consulta SQL agregada.

## Recomendación para producción

Registrar actividades administrativas mediante una Edge Function segura o backend privado; agregar auditoría, administración de usuarios y recuperación controlada de contraseñas. Para datos de menores aplica controles institucionales de privacidad, acceso mínimo y retención.
