-- Executado uma única vez pelo entrypoint do postgres, num volume vazio, como o superusuário
-- do container (POSTGRES_USER) no banco POSTGRES_DB.
--
-- Papéis:
--   migrator → dono do DDL (roda as migrations; job `migrate` do compose).
--   app      → só DML. Os GRANTs de tabela (INSERT/SELECT no ledger, sem UPDATE/DELETE etc.)
--              são dados pela migration 0001_init na F06, não aqui.
-- Senhas fixas: ambiente local de desenvolvimento.
CREATE ROLE migrator LOGIN PASSWORD 'migrator';
CREATE ROLE app LOGIN PASSWORD 'app';

GRANT CONNECT, TEMPORARY ON DATABASE wagering TO migrator, app;
GRANT USAGE, CREATE ON SCHEMA public TO migrator;
GRANT USAGE ON SCHEMA public TO app;

-- Defesa em profundidade: a aplicação nunca espera mais que isso por um lock.
ALTER ROLE app SET lock_timeout = '3s';
