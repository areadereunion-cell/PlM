
import { NextRequest, NextResponse } from 'next/server';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const tipo = searchParams.get('tipo');

    let query = `
      SELECT
        id,
        nombre,
        tipo,
        activa,
        orden
      FROM categorias
      WHERE activa = TRUE
    `;

    const params: string[] = [];

    if (tipo) {
      query += ` AND tipo = $1`;
      params.push(tipo);
    }

    query += ` ORDER BY orden ASC, id ASC`;

    const result = await pool.query(query, params);

    return NextResponse.json(result.rows);
  } catch (error) {
    console.error('Error obteniendo categorías:', error);

    return NextResponse.json(
      {
        error: 'Error al obtener categorías',
      },
      {
        status: 500,
      },
    );
  }
}