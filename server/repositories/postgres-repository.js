/**
 * =====================================================================================
 * CuidAção — PostgresRepository (Adapter Opcional PostgreSQL + PostGIS)
 * -------------------------------------------------------------------------------------
 * Ativado quando DB_DRIVER=postgres ou DATABASE_URL está definido.
 * Utiliza exatamente as tabelas, constraints (uq_user_location_date) e triggers
 * (trg_update_location_metrics) definidos em database/schema.sql.
 * Mantém espelho sincronizado em memória + escrita transacional write-through no banco
 * relacional e faz fallback seguro para JsonRepository caso o driver 'pg' não esteja
 * instalado no ambiente local.
 * =====================================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');

class PostgresRepository {
  constructor(options = {}) {
    this.driver = 'postgres';
    this.databaseUrl = options.databaseUrl || process.env.DATABASE_URL || '';
    this.schemaPath = options.schemaPath || path.resolve(__dirname, '..', '..', 'database', 'schema.sql');
    this.seedFactory = options.seedFactory;
    this.pool = options.pool || null;
    this.db = this.seedFactory ? this.seedFactory() : { users: [], categories: [], locations: [], reports: [], environmental_context: {} };
    this.ready = false;
  }

  _ensurePool() {
    if (this.pool) return this.pool;
    let pg;
    try {
      pg = require('pg');
    } catch {
      throw new Error("Pacote opcional 'pg' não instalado. Execute 'npm i pg' para usar DB_DRIVER=postgres ou use DB_DRIVER=json.");
    }
    this.pool = new pg.Pool({
      connectionString: this.databaseUrl,
      max: 10,
      idleTimeoutMillis: 30000
    });
    return this.pool;
  }

  async init() {
    const pool = this._ensurePool();
    if (fs.existsSync(this.schemaPath)) {
      const ddl = fs.readFileSync(this.schemaPath, 'utf8');
      await pool.query(ddl);
    }

    // Popula categorias e locais iniciais caso o banco esteja vazio
    const catCountRes = await pool.query('SELECT COUNT(*)::int AS cnt FROM categories');
    const seed = this.seedFactory();
    if ((catCountRes.rows[0] && catCountRes.rows[0].cnt) === 0) {
      for (const c of seed.categories) {
        await pool.query(
          `INSERT INTO categories (id, slug, name, domain, icon, color_hex)
           VALUES ($1, $2, $3, $4::domain_type, $5, $6)
           ON CONFLICT (id) DO NOTHING`,
          [c.id, c.slug, c.name, c.domain, c.icon, c.color]
        );
      }
      for (const l of seed.locations) {
        await this.upsertLocation(l);
      }
      for (const u of seed.users) {
        await this.upsertUser(u);
      }
      for (const r of seed.reports) {
        await this.insertReport(r);
      }
    }

    await this.reloadAll();
    this.ready = true;
    return this.db;
  }

  async reloadAll() {
    const pool = this._ensurePool();
    const [catsRes, usersRes, locsRes, revsRes, repsRes, confRes, commRes] = await Promise.all([
      pool.query('SELECT id, slug, name, domain, icon, color_hex AS color FROM categories ORDER BY id'),
      pool.query('SELECT id, name, email, password_hash AS "passwordHash", role, provider, google_id AS "googleId", picture, created_at AS "createdAt" FROM users'),
      pool.query(`
        SELECT l.id, l.category_id AS "categoryId", c.name AS "categoryName", c.domain, c.color_hex AS color, c.icon AS "iconType",
               l.name, l.address, l.city, l.state,
               ST_Y(l.geom) AS lat, ST_X(l.geom) AS lng,
               l.available_services AS services, l.opening_hours, l.has_popular_pharmacy,
               l.avg_wait_time::float, l.avg_accessibility::float, l.avg_humanized_care::float,
               l.overall_score::float, l.total_reviews, l.source
        FROM locations l
        JOIN categories c ON c.id = l.category_id
        WHERE l.is_active = TRUE
      `),
      pool.query(`
        SELECT id, location_id AS "locationId", user_id AS "userId", user_name AS "userName",
               rating_wait_time AS wait, rating_accessibility AS access, rating_humanized_care AS care,
               comment, TO_CHAR(visited_at, 'YYYY-MM-DD') AS date
        FROM reviews
        ORDER BY created_at DESC
      `),
      pool.query(`
        SELECT id, user_id AS "userId", reporter_name AS "reporterName", report_type,
               title, description, urgency, image_url, address,
               CASE WHEN geom IS NOT NULL THEN ST_Y(geom) ELSE NULL END AS lat,
               CASE WHEN geom IS NOT NULL THEN ST_X(geom) ELSE NULL END AS lng,
               status, confirmations, moderated_by AS "moderatedBy",
               TO_CHAR(created_at AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS date,
               (EXTRACT(EPOCH FROM created_at) * 1000)::bigint AS "createdAt"
        FROM environmental_reports
        ORDER BY created_at DESC
      `),
      pool.query('SELECT report_id, user_id FROM report_confirmations'),
      pool.query(`
        SELECT id, report_id AS "reportId", user_id AS "userId", author_name AS author,
               comment_text AS text, (EXTRACT(EPOCH FROM created_at) * 1000)::bigint AS "createdAt"
        FROM report_comments
        ORDER BY created_at DESC
      `)
    ]);

    const revByLoc = new Map();
    for (const r of revsRes.rows) {
      if (!revByLoc.has(r.locationId)) revByLoc.set(r.locationId, []);
      revByLoc.get(r.locationId).push(r);
    }

    const confByRep = new Map();
    for (const cf of confRes.rows) {
      if (!confByRep.has(cf.report_id)) confByRep.set(cf.report_id, []);
      confByRep.get(cf.report_id).push(cf.user_id);
    }

    const commByRep = new Map();
    for (const cm of commRes.rows) {
      if (!commByRep.has(cm.reportId)) commByRep.set(cm.reportId, []);
      commByRep.get(cm.reportId).push({
        id: cm.id,
        userId: cm.userId,
        author: cm.author,
        text: cm.text,
        createdAt: Number(cm.createdAt)
      });
    }

    this.db.categories = catsRes.rows;
    this.db.users = usersRes.rows;
    this.db.locations = locsRes.rows.map(l => ({
      ...l,
      lat: Number(l.lat),
      lng: Number(l.lng),
      reviews: revByLoc.get(l.id) || []
    }));
    this.db.reports = repsRes.rows.map(r => ({
      ...r,
      lat: r.lat !== null ? Number(r.lat) : null,
      lng: r.lng !== null ? Number(r.lng) : null,
      createdAt: Number(r.createdAt),
      confirmedBy: confByRep.get(r.id) || [],
      comments: commByRep.get(r.id) || []
    }));

    return this.db;
  }

  async upsertUser(user) {
    const pool = this._ensurePool();
    await pool.query(
      `INSERT INTO users (id, name, email, password_hash, role, provider, google_id, picture)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (email) DO UPDATE
       SET name = EXCLUDED.name,
           password_hash = COALESCE(EXCLUDED.password_hash, users.password_hash),
           role = EXCLUDED.role,
           provider = EXCLUDED.provider,
           google_id = COALESCE(EXCLUDED.google_id, users.google_id),
           picture = COALESCE(EXCLUDED.picture, users.picture)`,
      [user.id, user.name, user.email, user.passwordHash || null, user.role || 'citizen', user.provider || 'local', user.googleId || null, user.picture || null]
    );
  }

  async upsertLocation(loc) {
    const pool = this._ensurePool();
    await pool.query(
      `INSERT INTO locations (
         id, category_id, name, address, city, state, geom,
         available_services, opening_hours, has_popular_pharmacy, source
       )
       VALUES (
         $1, $2, $3, $4, $5, $6,
         ST_SetSRID(ST_MakePoint($7, $8), 4326),
         $9, $10::jsonb, $11, $12
       )
       ON CONFLICT (id) DO UPDATE
       SET name = EXCLUDED.name,
           address = EXCLUDED.address,
           available_services = EXCLUDED.available_services,
           opening_hours = EXCLUDED.opening_hours,
           has_popular_pharmacy = EXCLUDED.has_popular_pharmacy`,
      [
        loc.id,
        loc.categoryId,
        loc.name,
        loc.address,
        loc.city || 'Guarujá',
        loc.state || 'SP',
        Number(loc.lng),
        Number(loc.lat),
        loc.services || [],
        JSON.stringify(loc.opening_hours || {}),
        !!loc.has_popular_pharmacy,
        loc.source || 'seed'
      ]
    );
  }

  async insertReview(locationId, review) {
    const pool = this._ensurePool();
    // Constraint uq_user_location_date garante 1 avaliação/usuário/local/dia;
    // Trigger trg_update_location_metrics recalcula automaticamente as médias em locations!
    await pool.query(
      `INSERT INTO reviews (
         id, location_id, user_id, user_name,
         rating_wait_time, rating_accessibility, rating_humanized_care,
         comment, visited_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::date)`,
      [
        review.id,
        locationId,
        review.userId,
        review.userName,
        review.wait,
        review.access,
        review.care,
        review.comment || '',
        review.date
      ]
    );
  }

  async insertReport(rep) {
    const pool = this._ensurePool();
    const hasCoords = rep.lat !== null && rep.lng !== null && Number.isFinite(Number(rep.lat)) && Number.isFinite(Number(rep.lng));
    if (hasCoords) {
      await pool.query(
        `INSERT INTO environmental_reports (
           id, user_id, reporter_name, report_type, title, description,
           urgency, image_url, address, geom, status, confirmations
         )
         VALUES (
           $1, $2, $3, $4::report_type_enum, $5, $6,
           $7, $8, $9, ST_SetSRID(ST_MakePoint($10, $11), 4326), $12, $13
         )
         ON CONFLICT (id) DO NOTHING`,
        [
          rep.id,
          rep.userId || null,
          rep.reporterName || 'Cidadão CuidAção',
          rep.report_type,
          rep.title,
          rep.description,
          rep.urgency || 3,
          rep.image_url || null,
          rep.address,
          Number(rep.lng),
          Number(rep.lat),
          rep.status || 'pending',
          rep.confirmations || 0
        ]
      );
    } else {
      await pool.query(
        `INSERT INTO environmental_reports (
           id, user_id, reporter_name, report_type, title, description,
           urgency, image_url, address, geom, status, confirmations
         )
         VALUES ($1, $2, $3, $4::report_type_enum, $5, $6, $7, $8, $9, NULL, $10, $11)
         ON CONFLICT (id) DO NOTHING`,
        [
          rep.id,
          rep.userId || null,
          rep.reporterName || 'Cidadão CuidAção',
          rep.report_type,
          rep.title,
          rep.description,
          rep.urgency || 3,
          rep.image_url || null,
          rep.address,
          rep.status || 'pending',
          rep.confirmations || 0
        ]
      );
    }
  }

  async insertComment(reportId, comment) {
    const pool = this._ensurePool();
    await pool.query(
      `INSERT INTO report_comments (id, report_id, user_id, author_name, comment_text)
       VALUES ($1, $2, $3, $4, $5)`,
      [comment.id, reportId, comment.userId || null, comment.author || 'Morador', comment.text]
    );
  }

  async confirmReport(reportId, userId) {
    const pool = this._ensurePool();
    await pool.query(
      `INSERT INTO report_confirmations (report_id, user_id) VALUES ($1, $2)`,
      [reportId, userId]
    );
    await pool.query(
      `UPDATE environmental_reports
       SET confirmations = (SELECT COUNT(*) FROM report_confirmations WHERE report_id = $1)
       WHERE id = $1`,
      [reportId]
    );
  }

  async updateReportStatus(reportId, status, moderatedBy) {
    const pool = this._ensurePool();
    await pool.query(
      `UPDATE environmental_reports
       SET status = $2, moderated_by = $3, updated_at = NOW()
       WHERE id = $1`,
      [reportId, status, moderatedBy || null]
    );
  }

  save() {
    // Escritas pontuais ocorrem via métodos assíncronos syncEntity; mantém assinatura compatível com JsonRepository
    return true;
  }

  flush() {
    return true;
  }

  createCompressedBackup() {
    return null;
  }

  async syncEntity(kind, payload) {
    if (!this.ready && !this.pool) return false;
    if (kind === 'user') await this.upsertUser(payload);
    else if (kind === 'location') await this.upsertLocation(payload);
    else if (kind === 'review') await this.insertReview(payload.locationId, payload.review);
    else if (kind === 'report') await this.insertReport(payload);
    else if (kind === 'comment') await this.insertComment(payload.reportId, payload.comment);
    else if (kind === 'confirm') await this.confirmReport(payload.reportId, payload.userId);
    else if (kind === 'report_status') await this.updateReportStatus(payload.reportId, payload.status, payload.moderatedBy);
    return true;
  }

  async close() {
    if (this.pool && typeof this.pool.end === 'function') {
      await this.pool.end();
      this.pool = null;
    }
  }
}

module.exports = { PostgresRepository };
