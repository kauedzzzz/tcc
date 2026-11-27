/**
 * =====================================================================================
 * CuidAção — JsonRepository (Persistência Local Padrão sem Dependências Externas)
 * -------------------------------------------------------------------------------------
 * - Escrita atômica com debounce (.tmp -> rename) em DATA_DIR/data.json
 * - Backup automático rotativo comprimido via zlib.gzipSync em DATA_DIR/backups/
 * =====================================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DEFAULT_MAX_BACKUPS = parseInt(process.env.BACKUP_RETENTION_COUNT || '7', 10) || 7;
const DEFAULT_BACKUP_MIN_INTERVAL_MS = parseInt(process.env.BACKUP_INTERVAL_MS || String(15 * 60 * 1000), 10);

class JsonRepository {
  constructor(options = {}) {
    this.driver = 'json';
    this.dataDir = options.dataDir;
    this.dataFilePath = path.join(this.dataDir, 'data.json');
    this.backupsDir = path.join(this.dataDir, 'backups');
    this.seedFactory = options.seedFactory;
    this.seedDemoData = !!options.seedDemoData;
    this.keepDemoRatings = !!options.keepDemoRatings;
    this.recomputeLocationMetrics = options.recomputeLocationMetrics;
    this.saveTimer = null;
    this.lastBackupAt = 0;
    this.backupSeq = 0;
    this.db = this._loadOrSeed();
  }

  _loadOrSeed() {
    try { fs.mkdirSync(this.dataDir, { recursive: true }); } catch { /* ignora */ }
    const seed = this.seedFactory();

    try {
      if (fs.existsSync(this.dataFilePath)) {
        const raw = fs.readFileSync(this.dataFilePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.users) && Array.isArray(parsed.locations) && Array.isArray(parsed.reports)) {
          let updated = false;
          const beforeLen = parsed.locations.length;
          parsed.locations = parsed.locations.filter(l => l.id !== 'farm-guaruja-02');
          if (parsed.locations.length !== beforeLen) updated = true;

          for (const seedLoc of seed.locations) {
            const existing = parsed.locations.find(l => l.id === seedLoc.id);
            if (!existing) {
              parsed.locations.push(seedLoc);
              updated = true;
            } else if (typeof seedLoc.has_popular_pharmacy === 'boolean' && typeof existing.has_popular_pharmacy !== 'boolean') {
              existing.has_popular_pharmacy = seedLoc.has_popular_pharmacy;
              updated = true;
            }
          }

          if (!Array.isArray(parsed.categories)) {
            parsed.categories = seed.categories;
            updated = true;
          } else {
            for (const seedCat of seed.categories) {
              if (!parsed.categories.some(c => c.id === seedCat.id)) {
                parsed.categories.push(seedCat);
                updated = true;
              }
            }
          }

          parsed.users.forEach(u => {
            if (!['citizen', 'agent', 'admin'].includes(u.role)) {
              u.role = 'citizen';
              updated = true;
            }
          });

          if (this.seedDemoData) {
            for (const seedUser of seed.users) {
              if (!parsed.users.some(u => u.email.toLowerCase() === seedUser.email.toLowerCase())) {
                parsed.users.push(seedUser);
                updated = true;
              }
            }
          }

          parsed.reports.forEach(r => {
            if (!Array.isArray(r.comments)) { r.comments = []; updated = true; }
            if (typeof r.urgency !== 'number') { r.urgency = 4; updated = true; }
            if (!Array.isArray(r.confirmedBy)) { r.confirmedBy = []; updated = true; }
            if (typeof r.confirmations !== 'number') { r.confirmations = r.confirmedBy.length; updated = true; }
            if (!r.status) { r.status = 'pending'; updated = true; }
          });

          if (!parsed.environmental_context) {
            parsed.environmental_context = seed.environmental_context || {};
            updated = true;
          }

          if (!this.keepDemoRatings && typeof this.recomputeLocationMetrics === 'function') {
            parsed.locations.forEach(l => {
              if (!Array.isArray(l.reviews)) l.reviews = [];
              this.recomputeLocationMetrics(l);
            });
          }

          if (updated) {
            try {
              fs.writeFileSync(this.dataFilePath, JSON.stringify(parsed, null, 2), 'utf8');
            } catch { /* ignora */ }
          }

          this.db = parsed;
          // Cria backup rotativo inicial se ainda não houver backup recente
          this.createCompressedBackup({ silent: true });
          return parsed;
        }
      }
    } catch (err) {
      console.warn('⚠️ Aviso ao carregar data.json, inicializando com seed padrão:', err.message);
    }

    if (!this.keepDemoRatings && typeof this.recomputeLocationMetrics === 'function') {
      seed.locations.forEach(l => {
        if (!Array.isArray(l.reviews)) l.reviews = [];
        this.recomputeLocationMetrics(l);
      });
    }

    try {
      fs.writeFileSync(this.dataFilePath, JSON.stringify(seed, null, 2), 'utf8');
    } catch (err) {
      console.warn('⚠️ Não foi possível gravar data.json inicial:', err.message);
    }
    return seed;
  }

  writeNow() {
    if (!fs.existsSync(this.dataDir)) return false;
    const tmp = this.dataFilePath + '.tmp';
    try {
      const serialized = JSON.stringify(this.db, null, 2);
      fs.writeFileSync(tmp, serialized, 'utf8');
      fs.renameSync(tmp, this.dataFilePath);

      if (Date.now() - this.lastBackupAt >= DEFAULT_BACKUP_MIN_INTERVAL_MS) {
        this.createCompressedBackup({ silent: true, rawJson: serialized });
      }
      return true;
    } catch (err) {
      console.error('❌ Erro ao persistir data.json:', err.message);
      return false;
    }
  }

  save() {
    if (this.saveTimer) return true;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.writeNow();
    }, 250);
    if (this.saveTimer && typeof this.saveTimer.unref === 'function') {
      this.saveTimer.unref();
    }
    return true;
  }

  flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    return this.writeNow();
  }

  createCompressedBackup(opts = {}) {
    if (!fs.existsSync(this.dataDir)) return null;
    try {
      fs.mkdirSync(this.backupsDir, { recursive: true });
      const rawJson = opts.rawJson || JSON.stringify(this.db, null, 2);
      const compressed = zlib.gzipSync(Buffer.from(rawJson, 'utf8'), { level: 6 });

      const now = new Date();
      const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
      const seq = String(++this.backupSeq).padStart(3, '0');
      const fileName = `data-${stamp}-${seq}.json.gz`;
      const fullPath = path.join(this.backupsDir, fileName);
      const tmpPath = fullPath + '.tmp';

      fs.writeFileSync(tmpPath, compressed);
      fs.renameSync(tmpPath, fullPath);
      this.lastBackupAt = Date.now();

      // Rotação automática mantendo os N backups mais recentes
      const maxKeep = opts.maxBackups || DEFAULT_MAX_BACKUPS;
      const files = fs.readdirSync(this.backupsDir)
        .filter(f => f.startsWith('data-') && f.endsWith('.json.gz'))
        .sort();
      if (files.length > maxKeep) {
        const toDelete = files.slice(0, files.length - maxKeep);
        for (const oldFile of toDelete) {
          try { fs.unlinkSync(path.join(this.backupsDir, oldFile)); } catch { /* ignora */ }
        }
      }
      return fullPath;
    } catch (err) {
      if (!opts.silent) {
        console.warn('⚠️ Não foi possível criar backup comprimido:', err.message);
      }
      return null;
    }
  }

  async syncEntity() {
    return this.save();
  }

  async close() {
    this.flush();
  }
}

module.exports = { JsonRepository };
