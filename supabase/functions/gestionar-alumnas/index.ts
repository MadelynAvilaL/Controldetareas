// =====================================================================
// Edge Function: gestionar-alumnas
// Permite a una DOCENTE crear cuentas de alumnas (sin correo real) y
// cambiarles la contraseña. Se ejecuta en el servidor de Supabase, por
// eso puede usar la clave secreta sin exponerla en el navegador.
//
// Publicar: Supabase > Edge Functions > Deploy a new function > Via Editor
//   Nombre: gestionar-alumnas   ·   Pegar este código   ·   Deploy
//   Luego en Details/Settings desactivar "Verify JWT" (esta función
//   verifica la sesión por su cuenta).
// =====================================================================
import { createClient } from 'jsr:@supabase/supabase-js@2';

const DOMINIO = 'alumnas.invalid';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);

  try {
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    // 1. ¿Quién llama? Debe ser una docente activa.
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: { user }, error: authError } = await admin.auth.getUser(token);
    if (authError || !user) return json({ error: 'Sesión no válida. Vuelve a iniciar sesión.' }, 401);

    const { data: perfil } = await admin
      .from('usuarios').select('rol, activo').eq('id', user.id).single();
    if (!perfil || perfil.rol !== 'docente' || !perfil.activo) {
      return json({ error: 'Solo una docente puede hacer esto.' }, 403);
    }

    const body = await req.json();
    const password = String(body.password ?? '');
    if (password.length < 6) return json({ error: 'La contraseña debe tener al menos 6 caracteres.' }, 400);

    // 2. Crear cuenta de alumna
    if (body.accion === 'crear') {
      const usuario = String(body.usuario ?? '').trim().toLowerCase();
      const nombre = String(body.nombre ?? '').trim();
      const apellido = String(body.apellido ?? '').trim();
      const cursoId = body.curso_id ? String(body.curso_id) : null;

      if (!/^[a-z0-9._-]{3,50}$/.test(usuario)) {
        return json({ error: 'Usuario no válido: usa 3 a 50 letras minúsculas, números, punto, guion o guion bajo.' }, 400);
      }
      if (!nombre || !apellido || nombre.length > 100 || apellido.length > 100) {
        return json({ error: 'Escribe nombre y apellido.' }, 400);
      }
      if (cursoId) {
        const { data: curso } = await admin
          .from('cursos').select('id').eq('id', cursoId).eq('docente_id', user.id).maybeSingle();
        if (!curso) return json({ error: 'Ese curso no es tuyo.' }, 403);
      }
      const { data: existe } = await admin
        .from('usuarios').select('id').eq('usuario', usuario).maybeSingle();
      if (existe) return json({ error: `El usuario "${usuario}" ya existe. Elige otro.` }, 409);

      const { data: creado, error } = await admin.auth.admin.createUser({
        email: `${usuario}@${DOMINIO}`,
        password,
        email_confirm: true,
        user_metadata: { nombre, apellido },
      });
      if (error || !creado.user) {
        const msg = /already|registered|exists/i.test(error?.message ?? '')
          ? `El usuario "${usuario}" ya existe. Elige otro.`
          : `No se pudo crear la cuenta: ${error?.message}`;
        return json({ error: msg }, 400);
      }

      // El trigger de la base de datos crea el perfil; esto lo asegura.
      const { error: perfilError } = await admin.from('usuarios').upsert({
        id: creado.user.id, usuario, nombre, apellido, rol: 'alumna', activo: true,
      });
      if (perfilError) {
        await admin.auth.admin.deleteUser(creado.user.id);
        return json({ error: `No se pudo crear el perfil: ${perfilError.message}` }, 500);
      }

      if (cursoId) {
        await admin.from('inscripciones')
          .upsert({ curso_id: cursoId, alumna_id: creado.user.id }, { onConflict: 'curso_id,alumna_id' });
      }
      return json({ ok: true, id: creado.user.id, usuario });
    }

    // 3. Cambiar contraseña de una alumna de sus cursos
    if (body.accion === 'contrasena') {
      const alumnaId = String(body.alumna_id ?? '');
      const { data: inscrita } = await admin
        .from('inscripciones')
        .select('id, cursos!inner(docente_id)')
        .eq('alumna_id', alumnaId)
        .eq('cursos.docente_id', user.id)
        .limit(1);
      if (!inscrita?.length) return json({ error: 'Esa alumna no está en tus cursos.' }, 403);

      const { error } = await admin.auth.admin.updateUserById(alumnaId, { password });
      if (error) return json({ error: `No se pudo cambiar: ${error.message}` }, 400);
      return json({ ok: true });
    }

    return json({ error: 'Acción no reconocida.' }, 400);
  } catch (e) {
    return json({ error: `Error del servidor: ${(e as Error).message}` }, 500);
  }
});
