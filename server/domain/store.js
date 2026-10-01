'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Loads and saves the single race as JSON. The domain is intentionally small
 * (one race, a handful of participants and scans), so a plain JSON file is
 * simpler to ship than a database engine — no native module to compile on
 * the user's PC.
 */
class Store {
  constructor(filePath) {
    this.filePath = filePath;
  }

  load(createDefault) {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      return JSON.parse(raw);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error(`Could not read ${this.filePath}, starting fresh:`, error.message);
      }
      return createDefault();
    }
  }

  save(state) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmpPath, this.filePath);
  }
}

module.exports = { Store };
