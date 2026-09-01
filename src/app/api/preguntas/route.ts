import { NextRequest, NextResponse } from 'next/server';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    const tipo = searchParams.get('tipo');
    const categoria = searchParams.get('categoria');

    let query = `
      SELECT
        p.id,
        p.pregunta,
        p.tipo,
        p.categoria_id,
        c.nombre AS categoria,
        p.orden
      FROM preguntas p
      LEFT JOIN categorias c
        ON c.id = p.categoria_id
      WHERE p.activa = TRUE
    `;

    const params: string[] = [];
    let paramIndex = 1;

    // ==========================================
    // FILTRO POR TIPO
    // Ejemplo:
    // /api/preguntas?tipo=clasica
    // ==========================================

    if (tipo) {
      query += ` AND p.tipo = $${paramIndex}`;
      params.push(tipo);
      paramIndex++;
    }

    // ==========================================
    // FILTRO POR CATEGORÍA
    // Ejemplo:
    // /api/preguntas?categoria=Situaciones
    // ==========================================

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

    return NextResponse.json(result.rows);
  } catch (error) {
    console.error('Error obteniendo preguntas:', error);

    return NextResponse.json(
      {
        error: 'Error al obtener preguntas',
      },
      {
        status: 500,
      },
    );
  }
}