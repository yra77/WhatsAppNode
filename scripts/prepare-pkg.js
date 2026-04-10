#!/usr/bin/env node
/**
 * Підготовка проєкту до пакування через pkg.
 *
 * Навіщо:
 * - pkg не вбудовує каталоги Chromium із puppeteer (`.local-chromium`) у .exe;
 * - такі каталоги потрібно постачати поруч із .exe окремо;
 * - якщо каталог лишається в node_modules, pkg показує зайві warning-и.
 */

const fs = require('fs');
const path = require('path');

// Каталог Chromium, який створює puppeteer під час локальної розробки.
const puppeteerChromiumDir = path.join(process.cwd(), 'node_modules', 'puppeteer', '.local-chromium');

if (fs.existsSync(puppeteerChromiumDir)) {
  // Видаляємо dev-кеш Chromium, щоб pkg не намагався його додати у snapshot.
  fs.rmSync(puppeteerChromiumDir, { recursive: true, force: true });
  console.log(`[prepare-pkg] Removed: ${puppeteerChromiumDir}`);
} else {
  // Інформативний лог: це нормальний стан для чистого install або якщо chromium не завантажувався.
  console.log('[prepare-pkg] Nothing to clean (node_modules/puppeteer/.local-chromium not found).');
}
