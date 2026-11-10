-- NOTA: o backend atual persiste em server/data.json (arquivo). Este script é o MODELO ALVO
-- para migrar para PostgreSQL + PostGIS (recomendado quando houver muitos usuários/avaliações).
-- Para ficar 100% alinhado ao backend, mantenha a mesma regra: 1 avaliação por usuário/local/dia
-- (constraint uq_user_location_date) e métricas derivadas das avaliações (trigger abaixo).

-- =====================================================================================
-- PROJETO TCC: CuidAção - SAÚDE ÚNICA (ONE HEALTH) • GUARUJÁ/SP
-- Mapeamento Geoespacial de Saúde Pública e Sustentabilidade
-- Script DDL Oficial PostgreSQL + PostGIS (Sincronizado com Backend REST)
-- Equipe Back-End & Banco de Dados: Kauê, Igor e Pedro
-- Equipe Front-End & Design do Site: Jamily e Yasmin
-- =====================================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TYPE domain_type AS ENUM ('health', 'environment');
CREATE TYPE report_type_enum AS ENUM ('foco_dengue', 'descarte_irregular', 'terreno_baldio', 'esgoto_ceu_aberto');

-- 1. Tabela de Categorias (Saúde Pública e Sustentabilidade)
CREATE TABLE categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    slug VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    domain domain_type NOT NULL,
    icon VARCHAR(50) NOT NULL,
    color_hex VARCHAR(7) NOT NULL DEFAULT '#2563EB',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Tabela de Usuários (Suporte a Autenticação Local com Scrypt + Google OAuth 2.0)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(120) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NULL,
    provider VARCHAR(30) NOT NULL DEFAULT 'local',
    google_id VARCHAR(120) UNIQUE NULL,
    picture TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Tabela de Pontos de Interesse Georreferenciados (SUS & SEMAM)
CREATE TABLE locations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    category_id UUID NOT NULL REFERENCES categories(id),
    name VARCHAR(150) NOT NULL,
    address VARCHAR(255) NOT NULL,
    city VARCHAR(100) NOT NULL,
    state VARCHAR(2) NOT NULL,
    geom GEOMETRY(Point, 4326) NOT NULL,
    available_services TEXT[] DEFAULT '{}',
    opening_hours JSONB NOT NULL DEFAULT '{}',
    avg_wait_time NUMERIC(3, 2) DEFAULT 0.00,
    avg_accessibility NUMERIC(3, 2) DEFAULT 0.00,
    avg_humanized_care NUMERIC(3, 2) DEFAULT 0.00,
    overall_score NUMERIC(3, 2) DEFAULT 0.00,
    total_reviews INT DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_locations_geom ON locations USING GIST(geom);

-- 4. Tabela de Avaliações Comunitárias (Acessibilidade, Tempo de Espera e Atendimento)
CREATE TABLE reviews (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rating_wait_time INT NOT NULL CHECK (rating_wait_time BETWEEN 1 AND 5),
    rating_accessibility INT NOT NULL CHECK (rating_accessibility BETWEEN 1 AND 5),
    rating_humanized_care INT NOT NULL CHECK (rating_humanized_care BETWEEN 1 AND 5),
    comment TEXT,
    visited_at DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_user_location_date UNIQUE (user_id, location_id, visited_at)
);
CREATE INDEX idx_reviews_location_id ON reviews(location_id);

-- 5. Tabela de Alertas e Denúncias Ambientais Georreferenciadas
CREATE TABLE environmental_reports (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    reporter_name VARCHAR(120) NOT NULL DEFAULT 'Cidadão CuidAção',
    report_type report_type_enum NOT NULL,
    title VARCHAR(120) NOT NULL,
    description TEXT NOT NULL,
    address VARCHAR(255) NOT NULL,
    geom GEOMETRY(Point, 4326) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_reports_geom ON environmental_reports USING GIST(geom);

-- =====================================================================================
-- FUNÇÃO E TRIGGER PL/pgSQL: RECÁLCULO AUTOMÁTICO DE MÉTRICAS NA TABELA LOCATIONS
-- =====================================================================================
CREATE OR REPLACE FUNCTION fn_update_location_metrics()
RETURNS TRIGGER AS $$
DECLARE
    target_loc_id UUID;
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
        COALESCE(ROUND(AVG(rating_wait_time)::numeric, 2), 0.00),
        COALESCE(ROUND(AVG(rating_accessibility)::numeric, 2), 0.00),
        COALESCE(ROUND(AVG(rating_humanized_care)::numeric, 2), 0.00),
        COUNT(*)
    INTO v_wait, v_access, v_care, v_total
    FROM reviews
    WHERE location_id = target_loc_id;

    IF v_total > 0 THEN
        v_overall := ROUND(((v_wait + v_access + v_care) / 3.0)::numeric, 2);
    ELSE
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
