-- =====================================================================================
-- PROJETO TCC: CuidAção - SAÚDE ÚNICA (ONE HEALTH) • GUARUJÁ/SP
-- Mapeamento Geoespacial de Saúde Pública, Saúde Animal e Sustentabilidade
-- Script DDL Oficial PostgreSQL + PostGIS (Fonte Única Oficial — Sincronizado com PostgresRepository)
-- Equipe Back-End & Banco de Dados: Kauê, Igor e Pedro
-- Equipe Front-End & Design do Site: Jamily e Yasmin
-- =====================================================================================
-- NOTA: Por padrão (DB_DRIVER=json), o backend persiste localmente em server/data.json sem
-- exigir dependências externas. Ao definir DB_DRIVER=postgres e DATABASE_URL, o servidor
-- utiliza server/repositories/postgres-repository.js sobre exatamente este schema.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS postgis;

DO $$ BEGIN
    CREATE TYPE domain_type AS ENUM ('health', 'environment', 'animal');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE report_type_enum AS ENUM (
        'foco_dengue',
        'descarte_irregular',
        'terreno_baldio',
        'esgoto_ceu_aberto',
        'animal_ferido_silvestre',
        'risco_zoonose'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- 1. Tabela de Categorias (Saúde Humana, Saúde Animal e Sustentabilidade)
CREATE TABLE IF NOT EXISTS categories (
    id VARCHAR(64) PRIMARY KEY,
    slug VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    domain domain_type NOT NULL,
    icon VARCHAR(50) NOT NULL,
    color_hex VARCHAR(7) NOT NULL DEFAULT '#2563EB',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Tabela de Usuários (Autenticação Scrypt + Google OAuth 2.0 + RBAC)
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'citizen' CHECK (role IN ('citizen', 'agent', 'admin')),
    provider VARCHAR(30) NOT NULL DEFAULT 'local',
    google_id VARCHAR(120) UNIQUE NULL,
    picture TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Tabela de Pontos de Interesse Georreferenciados (SUS, SEMAM & CCZ Zoonoses)
CREATE TABLE IF NOT EXISTS locations (
    id VARCHAR(64) PRIMARY KEY,
    category_id VARCHAR(64) NOT NULL REFERENCES categories(id),
    name VARCHAR(180) NOT NULL,
    address VARCHAR(255) NOT NULL,
    city VARCHAR(100) NOT NULL,
    state VARCHAR(2) NOT NULL,
    geom GEOMETRY(Point, 4326) NOT NULL,
    available_services TEXT[] DEFAULT '{}',
    opening_hours JSONB NOT NULL DEFAULT '{}',
    has_popular_pharmacy BOOLEAN NOT NULL DEFAULT FALSE,
    avg_wait_time NUMERIC(3, 2) DEFAULT 0.00,
    avg_accessibility NUMERIC(3, 2) DEFAULT 0.00,
    avg_humanized_care NUMERIC(3, 2) DEFAULT 0.00,
    overall_score NUMERIC(3, 2) DEFAULT 0.00,
    total_reviews INT DEFAULT 0,
    source VARCHAR(40) NOT NULL DEFAULT 'seed',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_locations_geom ON locations USING GIST(geom);

-- 4. Tabela de Avaliações Comunitárias (1 avaliação por usuário/local/dia)
CREATE TABLE IF NOT EXISTS reviews (
    id VARCHAR(64) PRIMARY KEY,
    location_id VARCHAR(64) NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_name VARCHAR(120) NOT NULL DEFAULT 'Cidadão CuidAção',
    rating_wait_time INT NOT NULL CHECK (rating_wait_time BETWEEN 1 AND 5),
    rating_accessibility INT NOT NULL CHECK (rating_accessibility BETWEEN 1 AND 5),
    rating_humanized_care INT NOT NULL CHECK (rating_humanized_care BETWEEN 1 AND 5),
    comment TEXT,
    visited_at DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_user_location_date UNIQUE (user_id, location_id, visited_at)
);
CREATE INDEX IF NOT EXISTS idx_reviews_location_id ON reviews(location_id);

-- 5. Tabela de Alertas Ambientais e Publicações Comunitárias One Health
CREATE TABLE IF NOT EXISTS environmental_reports (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) REFERENCES users(id) ON DELETE SET NULL,
    reporter_name VARCHAR(120) NOT NULL DEFAULT 'Cidadão CuidAção',
    report_type report_type_enum NOT NULL,
    title VARCHAR(120) NOT NULL,
    description TEXT NOT NULL,
    urgency INT NOT NULL DEFAULT 3 CHECK (urgency BETWEEN 1 AND 5),
    image_url TEXT NULL,
    address VARCHAR(255) NOT NULL,
    geom GEOMETRY(Point, 4326) NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_analysis', 'resolved', 'rejected')),
    confirmations INT NOT NULL DEFAULT 0,
    moderated_by VARCHAR(120) NULL,
    updated_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reports_geom ON environmental_reports USING GIST(geom);

-- 6. Confirmações Comunitárias ("Eu também vi" — 1 por usuário/alerta)
CREATE TABLE IF NOT EXISTS report_confirmations (
    report_id VARCHAR(64) NOT NULL REFERENCES environmental_reports(id) ON DELETE CASCADE,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (report_id, user_id)
);

-- 7. Comentários em Alertas da Comunidade
CREATE TABLE IF NOT EXISTS report_comments (
    id VARCHAR(64) PRIMARY KEY,
    report_id VARCHAR(64) NOT NULL REFERENCES environmental_reports(id) ON DELETE CASCADE,
    user_id VARCHAR(64) REFERENCES users(id) ON DELETE SET NULL,
    author_name VARCHAR(120) NOT NULL DEFAULT 'Morador',
    comment_text VARCHAR(225) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_report_comments_report_id ON report_comments(report_id);

-- =====================================================================================
-- FUNÇÃO E TRIGGER PL/pgSQL: RECÁLCULO AUTOMÁTICO DE MÉTRICAS NA TABELA LOCATIONS
-- =====================================================================================
CREATE OR REPLACE FUNCTION fn_update_location_metrics()
RETURNS TRIGGER AS $$
DECLARE
    target_loc_id VARCHAR(64);
    v_sum_wait NUMERIC;
    v_sum_access NUMERIC;
    v_sum_care NUMERIC;
    v_wait NUMERIC(3, 2);
    v_access NUMERIC(3, 2);
    v_care NUMERIC(3, 2);
    v_overall NUMERIC(3, 2);
    v_total INT;
BEGIN
    IF (TG_OP = 'DELETE') THEN
        target_loc_id := OLD.location_id;
    ELSE
        target_loc_id := NEW.location_id;
    END IF;

    SELECT
        COALESCE(SUM(rating_wait_time), 0),
        COALESCE(SUM(rating_accessibility), 0),
        COALESCE(SUM(rating_humanized_care), 0),
        COUNT(*)
    INTO v_sum_wait, v_sum_access, v_sum_care, v_total
    FROM reviews
    WHERE location_id = target_loc_id;

    IF v_total > 0 THEN
        v_wait := ROUND((v_sum_wait / v_total)::numeric, 2);
        v_access := ROUND((v_sum_access / v_total)::numeric, 2);
        v_care := ROUND((v_sum_care / v_total)::numeric, 2);
        v_overall := ROUND(((v_sum_wait + v_sum_access + v_sum_care) / (3.0 * v_total))::numeric, 2);
    ELSE
        v_wait := 0.00;
        v_access := 0.00;
        v_care := 0.00;
        v_overall := 0.00;
    END IF;

    UPDATE locations
    SET
        avg_wait_time = v_wait,
        avg_accessibility = v_access,
        avg_humanized_care = v_care,
        overall_score = v_overall,
        total_reviews = v_total
    WHERE id = target_loc_id;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_location_metrics ON reviews;
CREATE TRIGGER trg_update_location_metrics
AFTER INSERT OR UPDATE OR DELETE ON reviews
FOR EACH ROW
EXECUTE FUNCTION fn_update_location_metrics();
