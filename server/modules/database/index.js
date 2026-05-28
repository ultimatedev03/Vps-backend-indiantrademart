import dbRouter from '../../routes/db.js';

export const databaseRoutes = Object.freeze([
  { path: '/api/db', router: dbRouter },
]);
