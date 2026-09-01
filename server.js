
require('dotenv').config();

const express = require('express');
const cors = require('cors');

const pool = require('./src/config/database');
const roomsRouter = require('./src/routes/rooms.routes');
const questionsRouter = require('./src/routes/questions.routes');

const app = express();

// ========================================
// MIDDLEWARE
// ========================================

app.use(cors());
app.use(express.json());

// ========================================
// RUTA PRINCIPAL
// ========================================

app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'API de Párame La Mano funcionando',
  });
});

// ========================================
// RUTAS
// ========================================

app.use('/api', roomsRouter);
app.use('/api', questionsRouter);

// ========================================
// PRUEBA DE POSTGRESQL
// ========================================

pool.query('SELECT NOW()')
  .then((result) => {
    console.log('');
    console.log('==============================');
    console.log(' POSTGRESQL CONECTADO');
    console.log('==============================');
    console.log('Hora de PostgreSQL:');
    console.log(result.rows[0]);
    console.log('==============================');
    console.log('');
  })
  .catch((error) => {
    console.error('');
    console.error('==============================');
    console.error(' ERROR DE POSTGRESQL');
    console.error('==============================');
    console.error(error.message);
    console.error('==============================');
    console.error('');
  });

// ========================================
// EXPORTAR PARA VERCEL
// ========================================

module.exports = app;

