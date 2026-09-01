const express = require('express');
const pool = require('../config/database');

const router = express.Router();

// ==========================================================
// GET /api/categorias
// Ejemplo:
// /api/categorias?tipo=preguntas
// ==========================================================

router.get('/categorias', async (req, res) => {
  try {
    const { tipo } = req.query;

    let query = `
      SELECT
        id,
        nombre,
        tipo,
        activa,
        orden,
        created_at
      FROM categorias
      WHERE activa = TRUE
    `;

    const params = [];

    if (tipo) {
      params.push(tipo);
      query += ` AND tipo = $1`;
    }

    query += `
      ORDER BY orden ASC, id ASC
    `;

    const result = await pool.query(query, params);

    res.status(200).json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error('Error al obtener categorías:', error);

    res.status(500).json({
      success: false,
      error: 'Error al obtener categorías',
    });
  }
});

// ==========================================================
// GET /api/preguntas
//
// Ejemplos:
//
// /api/preguntas?tipo=clasica
//
// /api/preguntas?categoria=Situaciones
// ==========================================================

router.get('/preguntas', async (req, res) => {
  try {
    const { tipo, categoria } = req.query;

    let query = `
      SELECT
        p.id,
        p.pregunta,
        p.tipo,
        p.categoria_id,
        c.nombre AS categoria,
        p.activa
      FROM preguntas p
      LEFT JOIN categorias c
        ON c.id = p.categoria_id
      WHERE p.activa = TRUE
    `;

    const params = [];
    let paramIndex = 1;

    // ======================================================
    // FILTRAR POR TIPO
    // ======================================================

    if (tipo) {
      query += ` AND p.tipo = $${paramIndex}`;
      params.push(tipo);
      paramIndex++;
    }

    // ======================================================
    // FILTRAR POR CATEGORÍA
    // ======================================================

    if (categoria) {
      query += ` AND c.nombre = $${paramIndex}`;
      params.push(categoria);
      paramIndex++;
    }

    query += `
      ORDER BY
        p.orden ASC,
        p.id ASC
    `;

    const result = await pool.query(query, params);

    res.status(200).json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error('Error al obtener preguntas:', error);

    res.status(500).json({
      success: false,
      error: 'Error al obtener preguntas',
    });
  }
});

module.exports = router;