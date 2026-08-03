-- =====================================================================
-- FestasBV — Migração: password temporária dada pelo admin
-- (festasbv.admin_pass_temp)
-- Correr no SQL Editor do Supabase (projeto festasbv).
-- É IDEMPOTENTE: pode ser corrido mais que uma vez sem erro.
-- Depende de: schema.sql -> functions.sql (is_admin) -> policies.sql.
--
-- O QUE É: quem se esquece da password recupera-a pelo email
-- ("Esqueci-me da password"), mas isso só funciona com o email a
-- funcionar — e o serviço de defeito do Supabase manda meia dúzia de
-- mensagens por hora, não deixa editar os templates sem SMTP próprio, e
-- os scanners de segurança do email gastam o link antes do dono lá
-- chegar. Enquanto isso não estiver montado (ou para quem não recebe o
-- email de todo), o admin gera uma password temporária na app, dá-la
-- pelo telefone, e a pessoa troca-a em Definições › Conta.
--
-- PORQUÊ UMA FUNÇÃO E NÃO UM UPDATE DA APP: a password vive em
-- auth.users, que não está exposta ao PostgREST nem pode estar — mexer
-- nela pela API precisaria da service_role, que NUNCA pode andar numa
-- app estática e pública. A função é SECURITY DEFINER (corre com os
-- direitos de quem a criou) e verifica ela própria quem está a chamar.
--
-- SEGURANÇA — o que a função garante, do lado do servidor:
--   · só o admin a pode executar (is_admin(), não a UI);
--   · só para contas que já têm acesso à app (allowed_users);
--   · não mexe na conta do próprio admin (essa muda-se no Supabase);
--   · search_path fixo, como as outras SECURITY DEFINER deste projeto.
-- A password vai em claro no corpo do pedido (HTTPS) porque o admin tem
-- de a poder ditar à pessoa; é temporária e para trocar à primeira.
--
-- bcrypt: é o que o GoTrue usa na coluna encrypted_password. O crypt() e
-- o gen_salt() vêm do pgcrypto — fica sem schema à frente de propósito,
-- para resolver esteja ele instalado em `extensions` ou em `public`.
--
-- NOTA: tem de ser criada por um role com direito de escrita em
-- auth.users (o `postgres` do SQL Editor tem). Se o CREATE passar mas a
-- chamada der "permission denied for table users", foi isto que falhou.
--
-- Tolerante: sem esta migração a app dá o aviso a dizer que falta
-- correr este ficheiro e o resto continua igual.
-- =====================================================================

CREATE OR REPLACE FUNCTION festasbv.admin_pass_temp(p_email text, p_password text)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'festasbv', 'public', 'extensions'
AS $$
DECLARE
  v_email text := lower(trim(p_email));
  v_id    uuid;
BEGIN
  IF NOT festasbv.is_admin() THEN
    RAISE EXCEPTION 'Apenas o administrador pode gerar passwords temporárias';
  END IF;
  IF v_email IS NULL OR v_email = '' OR p_password IS NULL OR length(p_password) < 8 THEN
    RAISE EXCEPTION 'Email em falta ou password demasiado curta (mínimo 8)';
  END IF;
  IF v_email = 'diogo.andre.f.silva@gmail.com' THEN
    RAISE EXCEPTION 'A password do administrador muda-se no Supabase';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM festasbv.allowed_users WHERE lower(email) = v_email) THEN
    RAISE EXCEPTION 'Essa conta não tem acesso à app';
  END IF;

  UPDATE auth.users
     -- custo 10 explícito: é o que o GoTrue usa: o defeito do gen_salt
     -- (6) daria um hash válido mas mais fraco do que o das outras contas
     SET encrypted_password = crypt(p_password, gen_salt('bf', 10)),
         -- conta criada e nunca confirmada não conseguiria entrar com a
         -- password nova; quem o admin já aprovou em allowed_users está
         -- confirmado por definição
         email_confirmed_at = COALESCE(email_confirmed_at, now()),
         updated_at         = now()
   WHERE lower(email) = v_email
   RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Não existe nenhuma conta com esse email';
  END IF;
  RETURN 'ok';
END;
$$;

-- Só contas autenticadas (a função filtra o admin lá dentro). O anon não
-- lhe toca: sem isto, a chave pública da app chegava para a chamar.
REVOKE ALL ON FUNCTION festasbv.admin_pass_temp(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION festasbv.admin_pass_temp(text, text) TO authenticated;
