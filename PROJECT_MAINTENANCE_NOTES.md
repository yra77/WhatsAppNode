# PROJECT_MAINTENANCE_NOTES

> Коментар: файл ведеться для фіксації актуальних змін, технічного боргу і наступних кроків по адаптації проєкту під CentOS.

## Останнє оновлення
- Дата: 2026-04-17
- Гілка: поточна робоча гілка

## Внесені зміни (актуально)
1. `index.js`
   - Підтримано `APP_HOST`/`HOST` для bind-адреси сервера.
   - Дефолтний bind: `0.0.0.0` (коректно для CentOS/VPS).
   - Автопошук браузера для Linux/CentOS (`google-chrome-stable`, `chromium`, тощо) + підтримка `CHROME_BIN`.
2. `.env.example`
   - Додано шаблон оточення з актуальними параметрами запуску на CentOS.
   - Додано коментарі до кожної змінної для швидкої первинної конфігурації.
3. `README.md`
   - Актуалізовано інструкції під CentOS Stream 8/9.
   - Додано реальний quick start через `cp .env.example .env`.
   - Уточнено запуск через systemd (`EnvironmentFile=/opt/WhatsAppNode/.env`).
   - Додано нагадування про SELinux діагностику в production.

## Що ще треба зробити
1. Додати валідацію payload для `POST /registerwhatsapp` та `POST /sendmsg` (наприклад, `zod`/`joi`).
2. Додати API-захист: token auth + rate limit + базовий audit лог запитів.
3. Додати документований backup/restore сценарій для `.wwebjs_auth` і `.wwebjs_cache`.
4. Додати `/healthz` endpoint з деталізованими причинами деградації (`qr_timeout`, `auth_failure`, `browser_crash`).
5. Додати RPM/Container deployment профілі (systemd unit template + preflight check скрипт для CentOS).

## Видалені/неактуальні дані
- Прибрано застарілий пункт «додати `.env.example`» (вже виконано).
- Прибрано нечіткі формулювання без прив'язки до CentOS-сценарію.
