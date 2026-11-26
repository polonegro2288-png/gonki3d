# 3D Гонка

Браузерная 3D-гонка на three.js: двусторонняя трёхполосная трасса, развороты, АЗС, топливо, задания, машины, нитро.

## Запуск у себя
```bash
npm start
# откройте http://localhost:3000
```
Нужен Node.js 18+. Сторонних зависимостей нет (three.js подгружается с CDN в `public/index.html`).

## Управление
- ← → / A D — смена полосы
- ↑ / W — газ, ↓ / S — тормоз
- Shift / N — нитро (у машины «Спорт»)
- E — заезд на АЗС / выезд, U — разворот в разрыве отбойника
- M — звук, ☰ — меню (машины и задания), ⛶ — во весь экран

## Выложить на GitHub
```bash
git init
git add .
git commit -m "3D гонка"
git branch -M main
git remote add origin https://github.com/ВАШ_ЛОГИН/gonki3d.git
git push -u origin main
```
(Репозиторий `gonki3d` сначала создайте на github.com через New repository, пустой, без README.)

## Запустить в интернете через Railway
1. Зайдите на railway.com и войдите через GitHub.
2. **New Project → Deploy from GitHub repo** и выберите `gonki3d`.
3. Railway сам определит Node.js и выполнит `npm start`.
4. Откройте сервис → **Settings → Networking → Generate Domain**. Получите ссылку вида `https://gonki3d-production.up.railway.app`.
5. Каждый `git push` в `main` автоматически обновляет игру.

## Аккаунты и сохранения
Регистрация и вход — меню ☰ → «Аккаунт», там же кнопки «Сохранить прогресс» и «Загрузить прогресс» (вручную). Прогресс (деньги, машины, рекорд, задания) хранится в Postgres и доступен с любого устройства; без входа — в localStorage браузера.
Нужна переменная `DATABASE_URL` (на Railway: `${{Postgres.DATABASE_URL}}`). Без неё игра работает, но аккаунты отключены. Таблицы создаются автоматически.
