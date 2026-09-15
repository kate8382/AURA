import fs from 'fs';
import path from 'path';

/**
 * MigrateCategories - class that migrates legacy `category` into
 * structured fields: `domain`, `category_slug`, `category_label`.
 */
export class MigrateCategories {
  root: string;
  casesDir: string;

  /**
   * @param root optional repository root; defaults to parent of this script
   */
  constructor(root?: string) {
    this.root = root ? path.resolve(root) : path.resolve(__dirname, '..');
    this.casesDir = path.join(this.root, 'public_cases');
  }

  /**
   * Recursively collect all .json files under `dir`.
   */
  walk(dir: string, res: string[] = []): string[] {
    if (!fs.existsSync(dir)) return res;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) this.walk(full, res);
      else if (ent.isFile() && ent.name.endsWith('.json')) res.push(full);
    }
    return res;
  }

  /**
   * Produce a short machine-friendly slug from a human label.
   */
  slugify(s: string): string {
    return (s || '')
      .toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/[^a-z0-9_\-]/g, '')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  /**
   * Walk an object tree; when a case root is detected (has `case_id`),
   * replace legacy `category` string with structured `domain` and `category`.
   * `category` will be the human label without the domain prefix.
   * Removes `category_label` and `category_slug` to avoid duplication.
   * Returns true if any mutation occurred.
   */
  applyToObject(obj: any, domainFromPath: string): boolean {
    if (!obj || typeof obj !== 'object') return false;
    if (Array.isArray(obj)) {
      let changed = false;
      for (const it of obj) if (this.applyToObject(it, domainFromPath)) changed = true;
      return changed;
    }
    let changed = false;
    if (obj.case_id) {
      const legacyCat: string | undefined = typeof obj.category === 'string' ? obj.category : undefined;
      const derivedDomain = domainFromPath || (legacyCat ? legacyCat.split('/')[0] : '');
      // compute human-friendly category label without domain prefix
      let humanCat = '';
      if (legacyCat) {
        humanCat = legacyCat.replace(new RegExp('^' + derivedDomain + '/?', 'i'), '');
      } else if (typeof obj.category_label === 'string') {
        humanCat = obj.category_label;
      } else if (typeof obj.category_slug === 'string') {
        humanCat = obj.category_slug;
      }

      // set structured fields
      if (obj.domain !== derivedDomain) {
        obj.domain = derivedDomain;
        changed = true;
      }
      if (obj.category !== humanCat) {
        obj.category = humanCat;
        changed = true;
      }

      // remove duplicates
      if ('category_label' in obj) {
        delete obj.category_label;
        changed = true;
      }
      if ('category_slug' in obj) {
        delete obj.category_slug;
        changed = true;
      }

      // check whether ordering needs to be adjusted so `case_id`, `domain`, `category` come first
      const currentKeys = Object.keys(obj);
      const needsReorder = !(currentKeys[0] === 'case_id' && currentKeys[1] === 'domain' && currentKeys[2] === 'category');
      if (needsReorder) changed = true;

      // reorder object so `case_id` and then `domain` and `category` come first
      if (changed) {
        const ordered: any = {};
        // keep `case_id` first, then `domain` and `category`, then the rest
        if ('case_id' in obj) ordered.case_id = obj.case_id;
        ordered.domain = obj.domain;
        ordered.category = obj.category;
        for (const k of Object.keys(obj)) {
          if (k === 'case_id' || k === 'domain' || k === 'category') continue;
          ordered[k] = obj[k];
        }
        // copy ordered keys back into obj
        for (const k of Object.keys(obj)) delete obj[k];
        for (const k of Object.keys(ordered)) obj[k] = ordered[k];
      }

      return changed;
    }
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (Array.isArray(v)) {
        for (const item of v) if (this.applyToObject(item, domainFromPath)) changed = true;
      } else if (v && typeof v === 'object') {
        if (this.applyToObject(v, domainFromPath)) changed = true;
      }
    }
    return changed;
  }

  /**
   * Execute migration over all case files. Returns number of files changed.
   */
  migrate(): number {
    const files = this.walk(this.casesDir);
    let changedFiles = 0;
    for (const f of files) {
      try {
        const raw = fs.readFileSync(f, 'utf8');
        const parsed = JSON.parse(raw);
        const rel = path.relative(this.casesDir, f);
        const parts = rel.split(path.sep);
        const domain = (parts[0] || '').toLowerCase();
        const before = JSON.stringify(parsed);
        this.applyToObject(parsed, domain);
        const after = JSON.stringify(parsed);
        if (after !== before) {
          fs.copyFileSync(f, f + '.bak');
          fs.writeFileSync(f, JSON.stringify(parsed, null, 2), 'utf8');
          changedFiles++;
          console.log('Migrated', f);
        }
      } catch (err) {
        // ignore parse/write errors per-file and continue
      }
    }
    return changedFiles;
  }
}

if (require.main === module) {
  const migrator = new MigrateCategories();
  const changed = migrator.migrate();
  console.log('Done. Files changed:', changed);
}
