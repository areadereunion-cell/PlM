const express = require('express');
const pool = require('../config/database');

const router = express.Router();

// ============================================================
// CONFIGURACIÓN
// ============================================================

const ROUND_COUNTDOWN_SECONDS = 10;
const VOTING_DISCONNECT_SECONDS = 15;

// ============================================================
// LETRAS
// ============================================================

function getDefaultLetters() {
  return [
    'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J',
    'K', 'L', 'M', 'N', 'Ñ', 'O', 'P', 'Q', 'R', 'S',
    'T', 'U', 'V', 'W', 'X', 'Y', 'Z'
  ];
}

function normalizeLetters(letters) {
  if (!Array.isArray(letters)) {
    return [];
  }

  return [
    ...new Set(
      letters
        .map(letter =>
          letter
            .toString()
            .trim()
            .toUpperCase()
        )
        .filter(letter =>
          /^[A-ZÑ]$/.test(letter)
        )
    )
  ];
}

function normalizeUsedLetters(letters) {
  if (!Array.isArray(letters)) {
    return [];
  }

  return [
    ...new Set(
      letters
        .map(letter =>
          letter
            .toString()
            .trim()
            .toUpperCase()
        )
        .filter(Boolean)
    )
  ];
}

// ============================================================
// CÓDIGO DE SALA
// ============================================================

function generateRoomCode() {
  const characters =
    'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  let code = 'PM';

  for (let i = 0; i < 4; i++) {
    const randomIndex =
      Math.floor(
        Math.random() * characters.length
      );

    code += characters[randomIndex];
  }

  return code;
}

// ============================================================
// SIGUIENTE LETRA
// ============================================================

function chooseNextLetter(
  letters,
  usedLetters
) {
  let normalizedLetters =
    normalizeLetters(letters);

  const normalizedUsed =
    normalizeUsedLetters(usedLetters);

  if (normalizedLetters.length === 0) {
    normalizedLetters =
      getDefaultLetters();
  }

  let available =
    normalizedLetters.filter(
      letter =>
        !normalizedUsed.includes(letter)
    );

  if (available.length === 0) {
    available =
      getDefaultLetters().filter(
        letter =>
          !normalizedUsed.includes(letter)
      );
  }

  if (available.length === 0) {
    return null;
  }

  const randomIndex =
    Math.floor(
      Math.random() * available.length
    );

  return available[randomIndex];
}

// ============================================================
// TIMER DE RONDA
// ============================================================

function getRoundCountdown(
  stopRequestedAt,
  roundLockedAt
) {
  if (
    !stopRequestedAt ||
    !roundLockedAt
  ) {
    return {
      countdown: 0,
      locked: false
    };
  }

  const lockTime =
    new Date(
      roundLockedAt
    ).getTime();

  const remaining =
    Math.ceil(
      (
        lockTime -
        Date.now()
      ) / 1000
    );

  const countdown =
    Math.max(
      0,
      remaining
    );

  return {
    countdown,
    locked:
      countdown <= 0
  };
}

// ============================================================
// OBTENER SALA
// ============================================================

async function getRoomByCode(code) {
  const result =
    await pool.query(
      `
      SELECT *
      FROM rooms
      WHERE UPPER(room_code) = UPPER($1)
      LIMIT 1
      `,
      [code]
    );

  if (
    result.rows.length === 0
  ) {
    return null;
  }

  return result.rows[0];
}

// ============================================================
// OBTENER JUGADORES
// ============================================================

async function getRoomPlayers(roomId) {
  const result =
    await pool.query(
      `
      SELECT
        id,
        room_id,
        player_id,
        player_name,
        joined_at,
        is_ready
      FROM room_players
      WHERE room_id = $1
      ORDER BY joined_at ASC
      `,
      [roomId]
    );

  return result.rows;
}

// ============================================================
// ASEGURAR CONSTRAINT DE RESPUESTAS
// ============================================================

async function ensureAnswersConstraint() {
  try {
    await pool.query(`
      DELETE FROM room_round_answers a
      USING room_round_answers b
      WHERE a.id > b.id
        AND a.room_id = b.room_id
        AND a.player_id = b.player_id
        AND a.round_number = b.round_number
        AND a.question = b.question
    `);
  } catch (error) {
    console.error(
      'ERROR LIMPIANDO DUPLICADOS DE RESPUESTAS:',
      error.message
    );
  }

  const constraintResult =
    await pool.query(`
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = 'room_round_answers'::regclass
        AND conname =
          'room_round_answers_unique'
      LIMIT 1
    `);

  if (
    constraintResult.rows.length === 0
  ) {
    await pool.query(`
      ALTER TABLE room_round_answers
      ADD CONSTRAINT room_round_answers_unique
      UNIQUE (
        room_id,
        player_id,
        round_number,
        question
      )
    `);
  }
}

// ============================================================
// ASEGURAR TABLA DE VOTACIONES
// ============================================================

async function ensureVotingTable() {
  // ----------------------------------------------------------
  // CREAR TABLA SI NO EXISTE
  // ----------------------------------------------------------

  await pool.query(`
    CREATE TABLE IF NOT EXISTS room_round_votes (
      id BIGSERIAL PRIMARY KEY,

      room_id BIGINT NOT NULL,

      round_number INTEGER NOT NULL,

      voter_player_id TEXT NOT NULL,

      answer_id BIGINT NULL,

      qualification TEXT NULL,

      votes JSONB DEFAULT '{}'::jsonb,

      completed_at TIMESTAMPTZ DEFAULT NOW(),

      voting_deadline_at TIMESTAMPTZ NULL,

      created_at TIMESTAMPTZ DEFAULT NOW(),

      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ----------------------------------------------------------
  // COLUMNAS LEGACY
  // ----------------------------------------------------------

  await pool.query(`
    ALTER TABLE room_round_votes
    ADD COLUMN IF NOT EXISTS answer_id BIGINT NULL
  `);

  await pool.query(`
    ALTER TABLE room_round_votes
    ADD COLUMN IF NOT EXISTS qualification TEXT NULL
  `);

  await pool.query(`
    ALTER TABLE room_round_votes
    ADD COLUMN IF NOT EXISTS votes JSONB
  `);

  await pool.query(`
    ALTER TABLE room_round_votes
    ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ
  `);

  await pool.query(`
    ALTER TABLE room_round_votes
    ADD COLUMN IF NOT EXISTS voting_deadline_at TIMESTAMPTZ NULL
  `);

  await pool.query(`
    ALTER TABLE room_round_votes
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ
  `);

  await pool.query(`
    ALTER TABLE room_round_votes
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ
  `);

  // ----------------------------------------------------------
  // REPARAR NULLS EXISTENTES
  // ----------------------------------------------------------

  await pool.query(`
    UPDATE room_round_votes
    SET votes = '{}'::jsonb
    WHERE votes IS NULL
  `);

  await pool.query(`
    UPDATE room_round_votes
    SET completed_at = COALESCE(
      completed_at,
      created_at,
      NOW()
    )
    WHERE completed_at IS NULL
  `);

  await pool.query(`
    UPDATE room_round_votes
    SET created_at = COALESCE(
      created_at,
      completed_at,
      NOW()
    )
    WHERE created_at IS NULL
  `);

  await pool.query(`
    UPDATE room_round_votes
    SET updated_at = COALESCE(
      updated_at,
      completed_at,
      created_at,
      NOW()
    )
    WHERE updated_at IS NULL
  `);

  // ----------------------------------------------------------
  // DEFAULTS / NOT NULL
  // ----------------------------------------------------------

  await pool.query(`
    ALTER TABLE room_round_votes
    ALTER COLUMN votes
    SET DEFAULT '{}'::jsonb
  `);

  await pool.query(`
    ALTER TABLE room_round_votes
    ALTER COLUMN votes SET NOT NULL
  `);

  await pool.query(`
    ALTER TABLE room_round_votes
    ALTER COLUMN completed_at
    SET DEFAULT NOW()
  `);

  await pool.query(`
    ALTER TABLE room_round_votes
    ALTER COLUMN completed_at SET NOT NULL
  `);

  await pool.query(`
    ALTER TABLE room_round_votes
    ALTER COLUMN created_at
    SET DEFAULT NOW()
  `);

  await pool.query(`
    ALTER TABLE room_round_votes
    ALTER COLUMN created_at SET NOT NULL
  `);

  await pool.query(`
    ALTER TABLE room_round_votes
    ALTER COLUMN updated_at
    SET DEFAULT NOW()
  `);

  await pool.query(`
    ALTER TABLE room_round_votes
    ALTER COLUMN updated_at SET NOT NULL
  `);

  // ----------------------------------------------------------
  // COLUMNAS ANTIGUAS
  // ----------------------------------------------------------

  await pool.query(`
    ALTER TABLE room_round_votes
    ALTER COLUMN answer_id DROP NOT NULL
  `);

  await pool.query(`
    ALTER TABLE room_round_votes
    ALTER COLUMN qualification DROP NOT NULL
  `);

  // ----------------------------------------------------------
  // ELIMINAR DUPLICADOS ANTES DEL UNIQUE
  // ----------------------------------------------------------

  try {
    await pool.query(`
      DELETE FROM room_round_votes a
      USING room_round_votes b
      WHERE a.id > b.id
        AND a.room_id = b.room_id
        AND a.round_number = b.round_number
        AND a.voter_player_id = b.voter_player_id
    `);
  } catch (error) {
    console.error(
      'ERROR LIMPIANDO DUPLICADOS DE VOTOS:',
      error.message
    );
  }

  // ----------------------------------------------------------
  // CONSTRAINT ÚNICO
  // ----------------------------------------------------------

  const constraintResult =
    await pool.query(`
      SELECT 1
      FROM pg_constraint
      WHERE conrelid =
        'room_round_votes'::regclass
        AND conname =
        'room_round_votes_unique'
      LIMIT 1
    `);

  if (
    constraintResult.rows.length === 0
  ) {
    await pool.query(`
      ALTER TABLE room_round_votes
      ADD CONSTRAINT room_round_votes_unique
      UNIQUE (
        room_id,
        round_number,
        voter_player_id
      )
    `);
  }
}

// ============================================================
// CLAVE DE VOTO
// ============================================================

function makeVoteKey(
  playerId,
  question
) {
  return `${playerId}|||${question}`;
}

// ============================================================
// ESTADO GLOBAL DE VOTACIÓN
// ============================================================
//
// MAYORÍA:
//
// 2 jugadores -> 2
// 3 jugadores -> 2
// 4 jugadores -> 3
// 5 jugadores -> 3
// 6 jugadores -> 4
//
// Al llegar a mayoría y quedar jugadores pendientes:
// empieza un único timer global de 15 segundos.
//
// ============================================================

async function getVotingState(
  roomId,
  roundNumber
) {
  const players =
    await getRoomPlayers(roomId);

  const totalPlayers =
    players.length;

  const client =
    await pool.connect();

  try {
    await client.query('BEGIN');

    // --------------------------------------------------------
    // VOTOS DE LA RONDA
    // FOR UPDATE evita que dos peticiones creen
    // deadlines diferentes al mismo tiempo.
    // --------------------------------------------------------

    const votesResult =
      await client.query(
        `
        SELECT
          id,
          voter_player_id,
          completed_at,
          voting_deadline_at
        FROM room_round_votes
        WHERE room_id = $1
          AND round_number = $2
        ORDER BY completed_at ASC
        FOR UPDATE
        `,
        [
          roomId,
          roundNumber
        ]
      );

    const votes =
      votesResult.rows;

    // --------------------------------------------------------
    // JUGADORES ÚNICOS QUE YA TERMINARON
    // --------------------------------------------------------

    const completedIds =
      new Set(
        votes
          .map(
            vote =>
              vote.voter_player_id
                ?.toString()
                .trim()
          )
          .filter(Boolean)
      );

    const completedPlayers =
      completedIds.size;

    // --------------------------------------------------------
    // MAYORÍA
    // --------------------------------------------------------

const majorityRequired =
  totalPlayers > 0
    ? Math.ceil(totalPlayers * 0.50)
    : 0;

const majorityReached =
  totalPlayers > 0 &&
  completedPlayers >= majorityRequired;

    // --------------------------------------------------------
    // TODOS TERMINARON
    // --------------------------------------------------------

    const allPlayersFinished =
      totalPlayers > 0 &&
      completedPlayers >=
        totalPlayers;

    // --------------------------------------------------------
    // DEADLINE GLOBAL EXISTENTE
    // --------------------------------------------------------

    let deadline = null;

    for (
      const vote
      of votes
    ) {
      if (
        vote.voting_deadline_at
      ) {
        deadline =
          vote.voting_deadline_at;

        break;
      }
    }

    // --------------------------------------------------------
    // CREAR TIMER DE 15 SEGUNDOS
    //
    // IMPORTANTE:
    // SOLO si se alcanzó mayoría y todavía falta alguien.
    // --------------------------------------------------------

    if (
      majorityReached &&
      !allPlayersFinished &&
      !deadline
    ) {
      deadline =
        new Date(
          Date.now() +
            VOTING_DISCONNECT_SECONDS *
              1000
        );

      await client.query(
        `
        UPDATE room_round_votes
        SET
          voting_deadline_at = $3,
          updated_at = NOW()
        WHERE room_id = $1
          AND round_number = $2
          AND voting_deadline_at IS NULL
        `,
        [
          roomId,
          roundNumber,
          deadline
        ]
      );

      console.log('');
      console.log(
        '================================'
      );
      console.log(
        ' TIMER DE VOTACIÓN INICIADO'
      );
      console.log(
        'SALA:',
        roomId
      );
      console.log(
        'RONDA:',
        roundNumber
      );
      console.log(
        'VOTOS:',
        completedPlayers,
        '/',
        totalPlayers
      );
      console.log(
        'MAYORÍA:',
        majorityRequired
      );
      console.log(
        '15 SEGUNDOS'
      );
      console.log(
        'DEADLINE:',
        deadline
      );
      console.log(
        '================================'
      );
      console.log('');
    }

    // --------------------------------------------------------
    // COUNTDOWN
    // --------------------------------------------------------

    let countdown = 0;

    if (deadline) {
      countdown =
        Math.max(
          0,
          Math.ceil(
            (
              new Date(
                deadline
              ).getTime() -
              Date.now()
            ) / 1000
          )
        );
    }

    // --------------------------------------------------------
    // TIMER TERMINADO
    // --------------------------------------------------------

    const timerFinished =
      deadline !== null &&
      countdown <= 0;

    // --------------------------------------------------------
    // VOTACIÓN TERMINADA
    // --------------------------------------------------------

    const votingFinished =
      allPlayersFinished ||
      timerFinished;

    // --------------------------------------------------------
    // PENDIENTES
    // --------------------------------------------------------

    const pendingPlayers =
      players
        .filter(
          player =>
            !completedIds.has(
              player.player_id
                ?.toString()
                .trim()
            )
        )
        .map(
          player => ({
            player_id:
              player.player_id,

            player_name:
              player.player_name
          })
        );

    await client.query('COMMIT');

    return {
      totalPlayers,
      completedPlayers,
      majorityRequired,
      majorityReached,
      allPlayersFinished,
      votingFinished,
      timerFinished,
      votingDeadlineAt:
        deadline,
      countdown,
      pendingPlayers,
      disconnectTimeout:
        VOTING_DISCONNECT_SECONDS
    };

  } catch (error) {
    try {
      await client.query(
        'ROLLBACK'
      );
    } catch (_) {}

    throw error;

  } finally {
    client.release();
  }
}

// ============================================================
// CREAR SALA
// ============================================================
router.get('/rooms', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM rooms
      ORDER BY id DESC
    `);

    res.status(200).json({
      success: true,
      rooms: result.rows,
    });
  } catch (error) {
    console.error('ERROR AL OBTENER SALAS:', error);

    res.status(500).json({
      success: false,
      message: 'Error al obtener las salas.',
      error: error.message,
    });
  }
});
router.post(
  '/rooms',
  async (req, res) => {
    try {
      const roomName =
        req.body.room_name;

      const maxPlayers =
        req.body.max_players;

      const rounds =
        req.body.rounds;

      const letters =
        req.body.letters || [];

      const questions =
        req.body.questions || [];

      const playerId =
        req.body.player_id;

      const playerName =
        req.body.player_name;

      if (
        !roomName ||
        roomName.toString().trim() === ''
      ) {
        return res.status(400).json({
          success: false,
          message:
            'El nombre de la sala es obligatorio.'
        });
      }

      if (
        maxPlayers === undefined ||
        maxPlayers === null
      ) {
        return res.status(400).json({
          success: false,
          message:
            'La cantidad de jugadores es obligatoria.'
        });
      }

      if (
        rounds === undefined ||
        rounds === null
      ) {
        return res.status(400).json({
          success: false,
          message:
            'La cantidad de rondas es obligatoria.'
        });
      }

      if (!playerId) {
        return res.status(400).json({
          success: false,
          message:
            'El jugador creador es obligatorio.'
        });
      }

      const cleanRoomName =
        roomName
          .toString()
          .trim();

      const creatorId =
        playerId
          .toString()
          .trim();

      const cleanLetters =
        normalizeLetters(
          letters
        );

      const cleanQuestions =
        Array.isArray(
          questions
        )
          ? questions
              .map(
                q =>
                  q
                    .toString()
                    .trim()
              )
              .filter(Boolean)
          : [];

      const roomCode =
        generateRoomCode();

      const result =
        await pool.query(
          `
          INSERT INTO rooms (
            room_name,
            room_code,
            max_players,
            rounds,
            creator_id,
            letters,
            questions,
            current_round,
            current_letter,
            used_letters,
            status,
            round_locked,
            round_lock_started_at,
            stop_requested_at,
            round_locked_at,
            next_round_at
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6::jsonb,
            $7::jsonb,
            1,
            NULL,
            '[]'::jsonb,
            'waiting',
            FALSE,
            NULL,
            NULL,
            NULL,
            NULL
          )
          RETURNING *
          `,
          [
            cleanRoomName,
            roomCode,
            maxPlayers,
            rounds,
            creatorId,
            JSON.stringify(
              cleanLetters
            ),
            JSON.stringify(
              cleanQuestions
            )
          ]
        );

      const room =
        result.rows[0];

      const creatorName =
        playerName &&
        playerName.toString().trim() !== ''
          ? playerName.toString().trim()
          : 'Jugador';

      await pool.query(
        `
        INSERT INTO room_players (
          room_id,
          player_id,
          player_name,
          is_ready
        )
        VALUES (
          $1,
          $2,
          $3,
          FALSE
        )
        ON CONFLICT (
          room_id,
          player_id
        )
        DO NOTHING
        `,
        [
          room.id,
          creatorId,
          creatorName
        ]
      );

      return res.status(201).json({
        success: true,
        message:
          'Sala creada correctamente.',
        room
      });

    } catch (error) {
      console.error(
        'ERROR AL CREAR SALA:',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          'Error al crear la sala.',
        error:
          error.message
      });
    }
  }
);

// ============================================================
// UNIRSE
// ============================================================

router.post(
  '/rooms/join',
  async (req, res) => {
    try {
      const roomCode =
        req.body.room_code;

      const playerId =
        req.body.player_id;

      const playerName =
        req.body.player_name;

      if (
        !roomCode ||
        !playerId ||
        !playerName
      ) {
        return res.status(400).json({
          success: false,
          message:
            'room_code, player_id y player_name son obligatorios.'
        });
      }

      const code =
        roomCode
          .toString()
          .trim()
          .toUpperCase();

      const cleanPlayerId =
        playerId
          .toString()
          .trim();

      const cleanPlayerName =
        playerName
          .toString()
          .trim();

      const room =
        await getRoomByCode(
          code
        );

      if (!room) {
        return res.status(404).json({
          success: false,
          message:
            'No existe una sala con ese código.'
        });
      }

      if (
        room.status !== 'waiting'
      ) {
        return res.status(400).json({
          success: false,
          message:
            'La partida ya comenzó.'
        });
      }

      const players =
        await getRoomPlayers(
          room.id
        );

      const existingPlayer =
        players.find(
          player =>
            player.player_id
              .toString()
              .trim() ===
            cleanPlayerId
        );

      if (existingPlayer) {
        return res.status(200).json({
          success: true,
          message:
            'El jugador ya está dentro de la sala.',
          room,
          players
        });
      }

      if (
        players.length >=
        Number(room.max_players)
      ) {
        return res.status(400).json({
          success: false,
          message:
            'La sala está llena.'
        });
      }

      await pool.query(
        `
        INSERT INTO room_players (
          room_id,
          player_id,
          player_name,
          is_ready
        )
        VALUES (
          $1,
          $2,
          $3,
          FALSE
        )
        `,
        [
          room.id,
          cleanPlayerId,
          cleanPlayerName
        ]
      );

      const updatedPlayers =
        await getRoomPlayers(
          room.id
        );

      return res.status(200).json({
        success: true,
        message:
          'Jugador unido correctamente.',
        room,
        players:
          updatedPlayers
      });

    } catch (error) {
      console.error(
        'ERROR AL UNIR:',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          'Error al unirse a la sala.',
        error:
          error.message
      });
    }
  }
);

// ============================================================
// INICIAR PARTIDA
// ============================================================

router.post(
  '/rooms/start',
  async (req, res) => {
    try {
      const roomCode =
        req.body.room_code;

      const playerId =
        req.body.player_id;

      if (
        !roomCode ||
        !playerId
      ) {
        return res.status(400).json({
          success: false,
          message:
            'room_code y player_id son obligatorios.'
        });
      }

      const code =
        roomCode
          .toString()
          .trim()
          .toUpperCase();

      const cleanPlayerId =
        playerId
          .toString()
          .trim();

      const room =
        await getRoomByCode(
          code
        );

      if (!room) {
        return res.status(404).json({
          success: false,
          message:
            'Sala no encontrada.'
        });
      }

      if (
        room.creator_id
          ?.toString()
          .trim() !==
        cleanPlayerId
      ) {
        return res.status(403).json({
          success: false,
          message:
            'Solo el creador puede iniciar la partida.'
        });
      }

      if (
        room.status !== 'waiting'
      ) {
        return res.status(400).json({
          success: false,
          message:
            `La sala ya no está esperando. Estado: ${room.status}`
        });
      }

      let availableLetters =
        normalizeLetters(
          room.letters
        );

      if (
        availableLetters.length === 0
      ) {
        availableLetters =
          getDefaultLetters();
      }

      const currentLetter =
        chooseNextLetter(
          availableLetters,
          []
        );

      if (!currentLetter) {
        return res.status(400).json({
          success: false,
          message:
            'No existen letras disponibles.'
        });
      }

      const updated =
        await pool.query(
          `
          UPDATE rooms
          SET
            status = 'playing',
            current_round = 1,
            current_letter = $2,
            used_letters = $3::jsonb,
            round_locked = FALSE,
            round_lock_started_at = NULL,
            stop_requested_at = NULL,
            round_locked_at = NULL,
            next_round_at = NULL
          WHERE id = $1
          RETURNING *
          `,
          [
            room.id,
            currentLetter,
            JSON.stringify(
              [currentLetter]
            )
          ]
        );

      return res.status(200).json({
        success: true,
        message:
          'Partida iniciada correctamente.',
        room:
          updated.rows[0],
        countdown: 0,
        locked: false
      });

    } catch (error) {
      console.error(
        'ERROR AL INICIAR:',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          'Error interno del servidor.',
        error:
          error.message
      });
    }
  }
);

// ============================================================
// PARAR RONDA
// ============================================================

router.post(
  '/rooms/stop',
  async (req, res) => {
    try {
      const roomCode =
        req.body.room_code;

      const playerId =
        req.body.player_id;

      if (
        !roomCode ||
        roomCode.toString().trim() === ''
      ) {
        return res.status(400).json({
          success: false,
          message:
            'El código de sala es obligatorio.'
        });
      }

      if (
        !playerId ||
        playerId.toString().trim() === ''
      ) {
        return res.status(400).json({
          success: false,
          message:
            'El jugador es obligatorio.'
        });
      }

      const code =
        roomCode
          .toString()
          .trim()
          .toUpperCase();

      const cleanPlayerId =
        playerId
          .toString()
          .trim();

      const room =
        await getRoomByCode(
          code
        );

      if (!room) {
        return res.status(404).json({
          success: false,
          message:
            'Sala no encontrada.'
        });
      }

      const playerResult =
        await pool.query(
          `
          SELECT *
          FROM room_players
          WHERE room_id = $1
            AND player_id = $2
          LIMIT 1
          `,
          [
            room.id,
            cleanPlayerId
          ]
        );

      if (
        playerResult.rows.length === 0
      ) {
        return res.status(403).json({
          success: false,
          message:
            'No perteneces a esta sala.'
        });
      }

      if (
        room.status !== 'playing'
      ) {
        return res.status(400).json({
          success: false,
          message:
            `La partida no está jugando. Estado: ${room.status}`
        });
      }

      if (
        room.round_locked === true
      ) {
        const timer =
          getRoundCountdown(
            room.stop_requested_at,
            room.round_locked_at
          );

        return res.status(200).json({
          success: true,
          message:
            'La ronda ya fue detenida.',
          room,
          countdown:
            timer.countdown,
          locked:
            timer.locked
        });
      }

      const stopRequestedAt =
        new Date();

      const roundLockedAt =
        new Date(
          stopRequestedAt.getTime() +
            ROUND_COUNTDOWN_SECONDS *
              1000
        );

      const updated =
        await pool.query(
          `
          UPDATE rooms
          SET
            round_locked = TRUE,
            round_lock_started_at = $2,
            stop_requested_at = $2,
            round_locked_at = $3,
            next_round_at = $3
          WHERE id = $1
            AND status = 'playing'
            AND COALESCE(
              round_locked,
              FALSE
            ) = FALSE
          RETURNING *
          `,
          [
            room.id,
            stopRequestedAt,
            roundLockedAt
          ]
        );

      if (
        updated.rows.length === 0
      ) {
        return res.status(409).json({
          success: false,
          message:
            'Otro jugador ya detuvo la ronda.'
        });
      }

      const updatedRoom =
        updated.rows[0];

      console.log('');
      console.log(
        '================================'
      );
      console.log(
        'RONDA DETENIDA'
      );
      console.log(
        'SALA:',
        updatedRoom.room_code
      );
      console.log(
        'JUGADOR:',
        cleanPlayerId
      );
      console.log(
        'RONDA:',
        updatedRoom.current_round
      );
      console.log(
        'LETRA:',
        updatedRoom.current_letter
      );
      console.log(
        '================================'
      );
      console.log('');

      return res.status(200).json({
        success: true,
        message:
          'Ronda detenida correctamente.',
        room:
          updatedRoom,
        countdown:
          ROUND_COUNTDOWN_SECONDS,
        locked: false
      });

    } catch (error) {
      console.error(
        'ERROR AL PARAR RONDA:',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          'Error al detener la ronda.',
        error:
          error.message
      });
    }
  }
);

// ============================================================
// SIGUIENTE RONDA
// ============================================================

router.post(
  '/rooms/next-round',
  async (req, res) => {
    try {
      const roomCode =
        req.body.room_code;

      const playerId =
        req.body.player_id;

      if (
        !roomCode ||
        !playerId
      ) {
        return res.status(400).json({
          success: false,
          message:
            'room_code y player_id son obligatorios.'
        });
      }

      const code =
        roomCode
          .toString()
          .trim()
          .toUpperCase();

      const cleanPlayerId =
        playerId
          .toString()
          .trim();

      const room =
        await getRoomByCode(
          code
        );

      if (!room) {
        return res.status(404).json({
          success: false,
          message:
            'Sala no encontrada.'
        });
      }

      if (
        room.creator_id
          ?.toString()
          .trim() !==
        cleanPlayerId
      ) {
        return res.status(403).json({
          success: false,
          message:
            'Solo el dueño de la partida puede continuar.'
        });
      }

      if (
        room.status !== 'playing'
      ) {
        return res.status(400).json({
          success: false,
          message:
            `La partida no está activa. Estado: ${room.status}`
        });
      }

      const currentRound =
        Number(
          room.current_round || 1
        );

      const totalRounds =
        Number(
          room.rounds || 1
        );

      if (
        room.round_locked !== true
      ) {
        return res.status(400).json({
          success: false,
          message:
            'La ronda actual todavía no ha sido detenida.',
          countdown: 0
        });
      }

      const timer =
        getRoundCountdown(
          room.stop_requested_at,
          room.round_locked_at
        );

      if (
        !timer.locked
      ) {
        return res.status(400).json({
          success: false,
          message:
            'La cuenta regresiva todavía está activa.',
          countdown:
            timer.countdown
        });
      }

      if (
        currentRound >=
        totalRounds
      ) {
        return res.status(400).json({
          success: false,
          message:
            'La partida ya llegó a la última ronda.',
          last_round: true
        });
      }

      const usedLetters =
        normalizeUsedLetters(
          room.used_letters
        );

      let availableLetters =
        normalizeLetters(
          room.letters
        );

      if (
        availableLetters.length === 0
      ) {
        availableLetters =
          getDefaultLetters();
      }

      const nextLetter =
        chooseNextLetter(
          availableLetters,
          usedLetters
        );

      if (!nextLetter) {
        return res.status(400).json({
          success: false,
          message:
            'Ya no quedan letras disponibles.'
        });
      }

      const nextRound =
        currentRound + 1;

      const newUsedLetters = [
        ...usedLetters,
        nextLetter
      ];

      const updated =
        await pool.query(
          `
          UPDATE rooms
          SET
            current_round = $2,
            current_letter = $3,
            used_letters = $4::jsonb,
            round_locked = FALSE,
            round_lock_started_at = NULL,
            stop_requested_at = NULL,
            round_locked_at = NULL,
            next_round_at = NULL
          WHERE id = $1
            AND status = 'playing'
          RETURNING *
          `,
          [
            room.id,
            nextRound,
            nextLetter,
            JSON.stringify(
              newUsedLetters
            )
          ]
        );

      if (
        updated.rows.length === 0
      ) {
        return res.status(409).json({
          success: false,
          message:
            'No se pudo cambiar de ronda.'
        });
      }

      // --------------------------------------------------------
      // IMPORTANTE:
      //
      // No borramos respuestas anteriores.
      // Se conservan para resultados finales.
      //
      // Los endpoints trabajan por round_number.
      // --------------------------------------------------------

      // --------------------------------------------------------
      // LIMPIAR VOTACIONES DE NADA MÁS SI ACASO
      //
      // No eliminamos histórico.
      // --------------------------------------------------------

      const updatedRoom =
        updated.rows[0];

      console.log('');
      console.log(
        '================================'
      );
      console.log(
        'NUEVA RONDA'
      );
      console.log(
        'SALA:',
        updatedRoom.room_code
      );
      console.log(
        'RONDA:',
        updatedRoom.current_round
      );
      console.log(
        'LETRA:',
        updatedRoom.current_letter
      );
      console.log(
        '================================'
      );
      console.log('');

      return res.status(200).json({
        success: true,
        message:
          'Siguiente ronda iniciada correctamente.',
        room:
          updatedRoom,
        countdown: 0,
        locked: false,
        last_round:
          nextRound >= totalRounds
      });

    } catch (error) {
      console.error(
        'ERROR SIGUIENTE RONDA:',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          'Error al crear la siguiente ronda.',
        error:
          error.message
      });
    }
  }
);

// ============================================================
// OBTENER RESPUESTAS DE TODOS
//
// GET /api/rooms/answers?room_code=PMA2WT&round=1
//
// SI UN JUGADOR NO RESPONDIÓ:
//
// answer = ''
//
// ============================================================

router.get(
  '/rooms/answers',
  async (req, res) => {
    try {
      await ensureVotingTable();

      const roomCode =
        req.query.room_code;

      const requestedRound =
        Number(
          req.query.round || 1
        );

      if (
        !roomCode ||
        roomCode.toString().trim() === ''
      ) {
        return res.status(400).json({
          success: false,
          message:
            'room_code es obligatorio.'
        });
      }

      if (
        !Number.isInteger(
          requestedRound
        ) ||
        requestedRound <= 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            'La ronda no es válida.'
        });
      }

      const code =
        roomCode
          .toString()
          .trim()
          .toUpperCase();

      const room =
        await getRoomByCode(
          code
        );

      if (!room) {
        return res.status(404).json({
          success: false,
          message:
            'Sala no encontrada.'
        });
      }

      const roundNumber =
        Number(
          room.current_round ||
            requestedRound
        );

      if (
        requestedRound !==
        roundNumber
      ) {
        return res.status(409).json({
          success: false,
          message:
            'La ronda solicitada no coincide con la ronda actual.',
          current_round:
            roundNumber
        });
      }

      // --------------------------------------------------------
      // PREGUNTAS
      // --------------------------------------------------------

      let questions = [];

      if (
        Array.isArray(
          room.questions
        )
      ) {
        questions =
          room.questions
            .map(
              question =>
                question
                  ?.toString()
                  .trim()
            )
            .filter(Boolean);
      }

      // --------------------------------------------------------
      // JUGADORES
      // --------------------------------------------------------

      const players =
        await getRoomPlayers(
          room.id
        );

      // --------------------------------------------------------
      // RESPUESTAS GUARDADAS
      // --------------------------------------------------------

      const answerResult =
        await pool.query(
          `
          SELECT
            id,
            room_id,
            player_id,
            player_name,
            question,
            answer,
            round_number,
            letter,
            created_at
          FROM room_round_answers
          WHERE room_id = $1
            AND round_number = $2
          ORDER BY
            player_name ASC,
            id ASC
          `,
          [
            room.id,
            roundNumber
          ]
        );

      const answerMap =
        new Map();

      for (
        const row
        of answerResult.rows
      ) {
        const key =
          `${row.player_id}|||${row.question}`;

        answerMap.set(
          key,
          row
        );
      }

      // --------------------------------------------------------
      // MATRIZ JUGADOR × PREGUNTA
      // --------------------------------------------------------

      const answers = [];

      for (
        const player
        of players
      ) {
        for (
          const question
          of questions
        ) {
          const key =
            `${player.player_id}|||${question}`;

          const existing =
            answerMap.get(
              key
            );

          answers.push({
            id:
              existing
                ? existing.id
                : null,

            room_id:
              room.id,

            round_number:
              roundNumber,

            player_id:
              player.player_id,

            player_name:
              player.player_name,

            question:
              question,

            answer:
              existing
                ? existing.answer
                    ?.toString()
                    .trim() ?? ''
                : '',

            letter:
              existing
                ? existing.letter ??
                  room.current_letter
                : room.current_letter,

            created_at:
              existing
                ? existing.created_at
                : null
          });
        }
      }

      // --------------------------------------------------------
      // ESTADO VOTACIÓN
      // --------------------------------------------------------

      const voting =
        await getVotingState(
          room.id,
          roundNumber
        );

      return res.status(200).json({
        success: true,

        room,

        answers,

        questions,

        players,

        voting: {
          round:
            roundNumber,

          total_players:
            voting.totalPlayers,

          completed_players:
            voting.completedPlayers,

          pending_players:
            voting.pendingPlayers,

          majority_required:
            voting.majorityRequired,

          majority_reached:
            voting.majorityReached,

          all_players_finished:
            voting.allPlayersFinished,

          voting_finished:
            voting.votingFinished,

          voting_deadline_at:
            voting.votingDeadlineAt,

          countdown:
            voting.countdown,

          disconnect_timeout:
            voting.disconnectTimeout
        }
      });

    } catch (error) {
      console.error(
        'ERROR OBTENIENDO RESPUESTAS:',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          'Error al obtener las respuestas.',
        error:
          error.message
      });
    }
  }
);

// ============================================================
// ENVIAR VOTACIÓN
//
// POST /api/rooms/voting/submit
//
// Cada jugador manda una sola votación completa.
//
// ============================================================

router.post(
  '/rooms/voting/submit',
  async (req, res) => {
    try {
      await ensureVotingTable();

      const roomCode =
        req.body.room_code;

      const voterPlayerId =
        req.body.player_id;

      const roundNumber =
        Number(
          req.body.round
        );

      const votes =
        req.body.votes;

      if (
        !roomCode ||
        roomCode.toString().trim() === ''
      ) {
        return res.status(400).json({
          success: false,
          message:
            'room_code es obligatorio.'
        });
      }

      if (
        !voterPlayerId ||
        voterPlayerId.toString().trim() === ''
      ) {
        return res.status(400).json({
          success: false,
          message:
            'player_id es obligatorio.'
        });
      }

      if (
        !Number.isInteger(
          roundNumber
        ) ||
        roundNumber <= 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            'La ronda no es válida.'
        });
      }

      if (!Array.isArray(votes)) {
        return res.status(400).json({
          success: false,
          message:
            'votes debe ser un array.'
        });
      }

      const code =
        roomCode
          .toString()
          .trim()
          .toUpperCase();

      const cleanVoterId =
        voterPlayerId
          .toString()
          .trim();

      const room =
        await getRoomByCode(
          code
        );

      if (!room) {
        return res.status(404).json({
          success: false,
          message:
            'Sala no encontrada.'
        });
      }

      const serverRound =
        Number(
          room.current_round || 1
        );

      if (
        roundNumber !==
        serverRound
      ) {
        return res.status(409).json({
          success: false,
          message:
            'La ronda enviada no coincide con la ronda actual.',
          current_round:
            serverRound
        });
      }

      // --------------------------------------------------------
      // JUGADOR
      // --------------------------------------------------------

      const playerResult =
        await pool.query(
          `
          SELECT
            id,
            room_id,
            player_id,
            player_name
          FROM room_players
          WHERE room_id = $1
            AND player_id = $2
          LIMIT 1
          `,
          [
            room.id,
            cleanVoterId
          ]
        );

      if (
        playerResult.rows.length === 0
      ) {
        return res.status(403).json({
          success: false,
          message:
            'El jugador no pertenece a esta sala.'
        });
      }

      // --------------------------------------------------------
      // ESTADO ACTUAL
      //
      // Permite detectar si ya expiró el timer.
      // --------------------------------------------------------

      const beforeVoting =
        await getVotingState(
          room.id,
          roundNumber
        );

      if (
        beforeVoting.timerFinished &&
        !beforeVoting.allPlayersFinished
      ) {
        const existingVote =
          await pool.query(
            `
            SELECT id
            FROM room_round_votes
            WHERE room_id = $1
              AND round_number = $2
              AND voter_player_id = $3
            LIMIT 1
            `,
            [
              room.id,
              roundNumber,
              cleanVoterId
            ]
          );

        if (
          existingVote.rows.length === 0
        ) {
          return res.status(409).json({
            success: false,
            message:
              'El tiempo de votación terminó.',
            voting: {
              ...beforeVoting,
              voting_finished: true
            }
          });
        }
      }

      // --------------------------------------------------------
      // NORMALIZAR VOTOS
      // --------------------------------------------------------

      const normalizedVotes = {};

      for (
        const vote
        of votes
      ) {
        if (
          !vote ||
          !vote.player_id ||
          !vote.question ||
          !vote.qualification
        ) {
          continue;
        }

        const targetPlayerId =
          vote.player_id
            .toString()
            .trim();

        const question =
          vote.question
            .toString()
            .trim();

        const qualification =
          vote.qualification
            .toString()
            .trim()
            .toLowerCase();

        if (
          ![
            'correcta',
            'repetida',
            'mal'
          ].includes(
            qualification
          )
        ) {
          continue;
        }

        normalizedVotes[
          makeVoteKey(
            targetPlayerId,
            question
          )
        ] =
          qualification;
      }

      // --------------------------------------------------------
      // GUARDAR UNA SOLA FILA POR VOTANTE
      // --------------------------------------------------------

      const saveResult =
        await pool.query(
          `
          INSERT INTO room_round_votes (
            room_id,
            round_number,
            voter_player_id,
            votes,
            completed_at,
            updated_at
          )
          VALUES (
            $1,
            $2,
            $3,
            $4::jsonb,
            NOW(),
            NOW()
          )
          ON CONFLICT (
            room_id,
            round_number,
            voter_player_id
          )
          DO UPDATE SET
            votes =
              EXCLUDED.votes,

            completed_at =
              NOW(),

            updated_at =
              NOW()
          RETURNING *
          `,
          [
            room.id,
            roundNumber,
            cleanVoterId,
            JSON.stringify(
              normalizedVotes
            )
          ]
        );

      const saved =
        saveResult.rows[0];

      // --------------------------------------------------------
      // RECALCULAR ESTADO
      //
      // AQUÍ ES DONDE SE ACTIVA EL TIMER.
      // --------------------------------------------------------

      const voting =
        await getVotingState(
          room.id,
          roundNumber
        );

      console.log('');
      console.log(
        '================================'
      );
      console.log(
        'VOTACIÓN RECIBIDA'
      );
      console.log(
        '================================'
      );
      console.log(
        'SALA:',
        code
      );
      console.log(
        'RONDA:',
        roundNumber
      );
      console.log(
        'JUGADOR:',
        cleanVoterId
      );
      console.log(
        'VOTOS:',
        Object.keys(
          normalizedVotes
        ).length
      );
      console.log(
        'COMPLETADOS:',
        voting.completedPlayers,
        '/',
        voting.totalPlayers
      );
      console.log(
        'MAYORÍA:',
        voting.majorityReached
      );
      console.log(
        'TIMER:',
        voting.countdown
      );
      console.log(
        'FINALIZADA:',
        voting.votingFinished
      );
      console.log(
        '================================'
      );
      console.log('');

      return res.status(200).json({
        success: true,

        message:
          'Votación guardada correctamente.',

        vote:
          saved,

        voting: {
          round:
            roundNumber,

          total_players:
            voting.totalPlayers,

          completed_players:
            voting.completedPlayers,

          pending_players:
            voting.pendingPlayers,

          majority_required:
            voting.majorityRequired,

          majority_reached:
            voting.majorityReached,

          all_players_finished:
            voting.allPlayersFinished,

          voting_finished:
            voting.votingFinished,

          voting_deadline_at:
            voting.votingDeadlineAt,

          countdown:
            voting.countdown,

          disconnect_timeout:
            voting.disconnectTimeout
        }
      });

    } catch (error) {
      console.error(
        'ERROR GUARDANDO VOTACIÓN:',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          'Error al guardar la votación.',
        error:
          error.message
      });
    }
  }
);

// ============================================================
// ESTADO DE VOTACIÓN
//
// GET /api/rooms/voting-status
// ?room_code=PMA2WT
// &round=1
//
// ============================================================

router.get(
  '/rooms/voting-status',
  async (req, res) => {
    try {
      await ensureVotingTable();

      const roomCode =
        req.query.room_code;

      const roundNumber =
        Number(
          req.query.round || 1
        );

      if (
        !roomCode ||
        roomCode.toString().trim() === ''
      ) {
        return res.status(400).json({
          success: false,
          message:
            'room_code es obligatorio.'
        });
      }

      if (
        !Number.isInteger(
          roundNumber
        ) ||
        roundNumber <= 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            'La ronda no es válida.'
        });
      }

      const code =
        roomCode
          .toString()
          .trim()
          .toUpperCase();

      const room =
        await getRoomByCode(
          code
        );

      if (!room) {
        return res.status(404).json({
          success: false,
          message:
            'Sala no encontrada.'
        });
      }

      const serverRound =
        Number(
          room.current_round || 1
        );

      if (
        roundNumber !==
        serverRound
      ) {
        return res.status(409).json({
          success: false,
          message:
            'La ronda no coincide con la ronda actual.',
          current_round:
            serverRound
        });
      }

      const voting =
        await getVotingState(
          room.id,
          roundNumber
        );

      console.log(
        'VOTING STATUS:',
        code,
        '| RONDA:',
        roundNumber,
        '|',
        voting.completedPlayers,
        '/',
        voting.totalPlayers,
        '| MAYORÍA:',
        voting.majorityReached,
        '| TIMER:',
        voting.countdown,
        '| FIN:',
        voting.votingFinished
      );

      return res.status(200).json({
        success: true,

        room: {
          room_code:
            room.room_code,

          current_round:
            room.current_round,

          current_letter:
            room.current_letter,

          status:
            room.status
        },

        voting: {
          round:
            roundNumber,

          total_players:
            voting.totalPlayers,

          completed_players:
            voting.completedPlayers,

          pending_players:
            voting.pendingPlayers,

          majority_required:
            voting.majorityRequired,

          majority_reached:
            voting.majorityReached,

          all_players_finished:
            voting.allPlayersFinished,

          voting_finished:
            voting.votingFinished,

          voting_deadline_at:
            voting.votingDeadlineAt,

          countdown:
            voting.countdown,

          disconnect_timeout:
            voting.disconnectTimeout
        }
      });

    } catch (error) {
      console.error(
        'ERROR ESTADO VOTACIÓN:',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          'Error obteniendo el estado de votación.',
        error:
          error.message
      });
    }
  }
);

// ============================================================
// OBTENER SALA
// ============================================================
//
// IMPORTANTE:
// Esta ruta queda DESPUÉS de las rutas estáticas:
// /rooms/answers
// /rooms/voting/submit
// /rooms/voting-status
// /rooms/final-results
//
// ============================================================
// ============================================================
// RESULTADOS FINALES DE LA PARTIDA
// ============================================================
//
// GET:
// /api/rooms/final-results?room_code=PMA2WT
//
// REGLAS:
//
// CORRECTA  = 100
// REPETIDA  = 50
// MAL       = 0
//
// Cada respuesta recibe puntos UNA SOLA VEZ por ronda.
// Los votos de los jugadores se usan para determinar
// la calificación final de esa respuesta.
//
// La decisión se toma con los votos registrados.
// Si existe empate entre calificaciones,
// la respuesta queda en 0 puntos.
//
// ============================================================

router.get(
  '/rooms/final-results',
  async (req, res) => {
    try {
      const roomCode = req.query.room_code;

      // --------------------------------------------------------
      // VALIDAR CÓDIGO
      // --------------------------------------------------------

      if (
        !roomCode ||
        roomCode.toString().trim() === ''
      ) {
        return res.status(400).json({
          success: false,
          message: 'room_code es obligatorio.'
        });
      }

      const code =
        roomCode
          .toString()
          .trim()
          .toUpperCase();

      // --------------------------------------------------------
      // BUSCAR SALA
      // --------------------------------------------------------

      const roomResult =
        await pool.query(
          `
          SELECT
            id,
            room_code,
            room_name,
            rounds,
            current_round,
            status
          FROM rooms
          WHERE UPPER(room_code) = UPPER($1)
          LIMIT 1
          `,
          [code]
        );

      if (
        roomResult.rows.length === 0
      ) {
        return res.status(404).json({
          success: false,
          message: 'Sala no encontrada.'
        });
      }

      const room =
        roomResult.rows[0];

      // --------------------------------------------------------
      // JUGADORES
      // --------------------------------------------------------

      const playersResult =
        await pool.query(
          `
          SELECT
            player_id,
            player_name,
            joined_at
          FROM room_players
          WHERE room_id = $1
          ORDER BY joined_at ASC
          `,
          [room.id]
        );

      const players =
        playersResult.rows;

      // --------------------------------------------------------
      // RESPUESTAS REGISTRADAS
      // --------------------------------------------------------

      const answersResult =
        await pool.query(
          `
          SELECT
            id,
            room_id,
            player_id,
            player_name,
            question,
            answer,
            round_number,
            letter,
            created_at
          FROM room_round_answers
          WHERE room_id = $1
          ORDER BY
            round_number ASC,
            id ASC
          `,
          [room.id]
        );

      const answers =
        answersResult.rows;

      // --------------------------------------------------------
      // VOTOS JSONB
      //
      // votes:
      //
      // {
      //   "player|||Color": "correcta",
      //   "player|||Ciudad": "mal"
      // }
      //
      // --------------------------------------------------------

      const jsonVotesResult =
        await pool.query(
          `
          SELECT
            id,
            round_number,
            voter_player_id,
            completed_at,
            votes
          FROM room_round_votes
          WHERE room_id = $1
            AND votes IS NOT NULL
            AND jsonb_typeof(votes) = 'object'
            AND votes <> '{}'::jsonb
          ORDER BY
            round_number ASC,
            completed_at ASC
          `,
          [room.id]
        );

      // --------------------------------------------------------
      // VOTOS ANTIGUOS
      //
      // Se usan solamente para registros donde NO existe
      // información útil dentro de votes.
      // --------------------------------------------------------

      const legacyVotesResult =
        await pool.query(
          `
          SELECT
            id,
            round_number,
            voter_player_id,
            answer_id,
            qualification,
            completed_at
          FROM room_round_votes
          WHERE room_id = $1
            AND qualification IS NOT NULL
            AND (
              votes IS NULL
              OR votes = '{}'::jsonb
            )
          ORDER BY
            round_number ASC,
            completed_at ASC
          `,
          [room.id]
        );

      // ========================================================
      // NORMALIZAR TODOS LOS VOTOS
      // ========================================================

      const normalizedVoteRows = [];

      // --------------------------------------------------------
      // VOTOS JSONB
      // --------------------------------------------------------

      for (
        const row
        of jsonVotesResult.rows
      ) {
        const votes =
          row.votes;

        if (
          !votes ||
          typeof votes !== 'object' ||
          Array.isArray(votes)
        ) {
          continue;
        }

        for (
          const [voteKey, qualification]
          of Object.entries(votes)
        ) {
          const separator =
            voteKey.indexOf('|||');

          if (
            separator === -1
          ) {
            continue;
          }

          const targetPlayerId =
            voteKey
              .substring(
                0,
                separator
              )
              .trim();

          const question =
            voteKey
              .substring(
                separator + 3
              )
              .trim();

          const cleanQualification =
            qualification
              ?.toString()
              .trim()
              .toLowerCase();

          if (
            !targetPlayerId ||
            !question
          ) {
            continue;
          }

          if (
            ![
              'correcta',
              'repetida',
              'mal'
            ].includes(
              cleanQualification
            )
          ) {
            continue;
          }

          normalizedVoteRows.push({
            id:
              row.id,

            round_number:
              Number(row.round_number),

            voter_player_id:
              row.voter_player_id
                ?.toString()
                .trim(),

            target_player_id:
              targetPlayerId,

            question:
              question,

            qualification:
              cleanQualification,

            completed_at:
              row.completed_at
          });
        }
      }

      // --------------------------------------------------------
      // VOTOS LEGACY
      // --------------------------------------------------------

      for (
        const row
        of legacyVotesResult.rows
      ) {
        const qualification =
          row.qualification
            ?.toString()
            .trim()
            .toLowerCase();

        if (
          ![
            'correcta',
            'repetida',
            'mal'
          ].includes(
            qualification
          )
        ) {
          continue;
        }

        // ------------------------------------------------------
        // Buscar la respuesta correspondiente por answer_id
        // ------------------------------------------------------

        const answer =
          answers.find(
            item =>
              Number(item.id) ===
              Number(row.answer_id)
          );

        if (!answer) {
          continue;
        }

        normalizedVoteRows.push({
          id:
            row.id,

          round_number:
            Number(row.round_number),

          voter_player_id:
            row.voter_player_id
              ?.toString()
              .trim(),

          target_player_id:
            answer.player_id
              ?.toString()
              .trim(),

          question:
            answer.question
              ?.toString()
              .trim(),

          qualification:
            qualification,

          completed_at:
            row.completed_at
        });
      }

      // ========================================================
      // DETERMINAR CALIFICACIÓN FINAL DE CADA RESPUESTA
      // ========================================================
      //
      // Clave:
      //
      // ronda ||| jugador ||| pregunta
      //
      // ========================================================

      const qualificationGroups = new Map();

      for (
        const vote
        of normalizedVoteRows
      ) {
        const key =
          [
            vote.round_number,
            vote.target_player_id,
            vote.question
          ].join('|||');

        if (
          !qualificationGroups.has(key)
        ) {
          qualificationGroups.set(
            key,
            {
              round_number:
                vote.round_number,

              target_player_id:
                vote.target_player_id,

              question:
                vote.question,

              votes: []
            }
          );
        }

        qualificationGroups
          .get(key)
          .votes
          .push(vote);
      }

      // ========================================================
      // MAPA DE PUNTOS POR RESPUESTA
      // ========================================================

      const finalAnswerScores = new Map();

      for (
        const [
          key,
          group
        ]
        of qualificationGroups.entries()
      ) {
        const counters = {
          correcta: 0,
          repetida: 0,
          mal: 0
        };

        for (
          const vote
          of group.votes
        ) {
          counters[
            vote.qualification
          ]++;
        }

        const totalVotes =
          group.votes.length;

        let finalQualification = 'mal';

        // ------------------------------------------------------
        // Encontrar la mayor cantidad
        // ------------------------------------------------------

        const sortedQualifications =
          Object.entries(
            counters
          ).sort(
            (a, b) =>
              Number(b[1]) -
              Number(a[1])
          );

        const best =
          sortedQualifications[0];

        const second =
          sortedQualifications[1];

        // ------------------------------------------------------
        // Necesitamos que la calificación ganadora tenga
        // al menos 50% de los votos disponibles.
        // ------------------------------------------------------

        if (
          best &&
          Number(best[1]) > 0 &&
          Number(best[1]) * 2 >=
            totalVotes
        ) {
          // ----------------------------------------------------
          // Evitar empate
          // ----------------------------------------------------

          if (
            second &&
            Number(second[1]) ===
              Number(best[1])
          ) {
            finalQualification =
              'mal';
          } else {
            finalQualification =
              best[0];
          }
        }

        let points = 0;

        switch (
          finalQualification
        ) {
          case 'correcta':
            points = 100;
            break;

          case 'repetida':
            points = 50;
            break;

          case 'mal':
          default:
            points = 0;
            break;
        }

        finalAnswerScores.set(
          key,
          {
            round_number:
              group.round_number,

            player_id:
              group.target_player_id,

            question:
              group.question,

            qualification:
              finalQualification,

            points:
              points,

            votes_received:
              totalVotes,

            correcta:
              counters.correcta,

            repetida:
              counters.repetida,

            mal:
              counters.mal
          }
        );
      }

      // ========================================================
      // MAPA FINAL DE JUGADORES
      // ========================================================

      const finalScores = {};

      for (
        const player
        of players
      ) {
        const playerId =
          player.player_id
            ?.toString()
            .trim();

        if (!playerId) {
          continue;
        }

        finalScores[playerId] = {
          player_id:
            playerId,

          name:
            player.player_name ||
            'Jugador',

          points:
            0,

          rounds_played:
            0,

          correct_votes:
            0,

          repeated_votes:
            0,

          bad_votes:
            0
        };
      }

      // ========================================================
      // SUMAR RESULTADOS
      // ========================================================

      for (
        const [
          key,
          result
        ]
        of finalAnswerScores.entries()
      ) {
        const playerId =
          result.player_id
            ?.toString()
            .trim();

        if (
          !playerId ||
          !finalScores[playerId]
        ) {
          continue;
        }

        finalScores[playerId]
          .points +=
            Number(result.points);

        if (
          result.qualification ===
          'correcta'
        ) {
          finalScores[playerId]
            .correct_votes++;
        }

        else if (
          result.qualification ===
          'repetida'
        ) {
          finalScores[playerId]
            .repeated_votes++;
        }

        else {
          finalScores[playerId]
            .bad_votes++;
        }
      }

      // ========================================================
      // RONDAS JUGADAS
      //
      // Se consideran rondas donde:
      //
      // - el jugador tiene respuestas
      // - o recibió una votación
      // ========================================================

      for (
        const player
        of players
      ) {
        const playerId =
          player.player_id
            ?.toString()
            .trim();

        if (
          !playerId ||
          !finalScores[playerId]
        ) {
          continue;
        }

        const playerRounds =
          new Set();

        // Respuestas
        for (
          const answer
          of answers
        ) {
          if (
            answer.player_id
              ?.toString()
              .trim() ===
            playerId
          ) {
            playerRounds.add(
              Number(
                answer.round_number
              )
            );
          }
        }

        // Votos recibidos
        for (
          const result
          of finalAnswerScores.values()
        ) {
          if (
            result.player_id
              ?.toString()
              .trim() ===
            playerId
          ) {
            playerRounds.add(
              Number(
                result.round_number
              )
            );
          }
        }

        finalScores[playerId]
          .rounds_played =
            playerRounds.size;
      }

      // ========================================================
      // CREAR RANKING
      // ========================================================

      const ranking =
        Object.values(
          finalScores
        );

      ranking.sort(
        (a, b) => {
          const pointsCompare =
            Number(b.points) -
            Number(a.points);

          if (
            pointsCompare !== 0
          ) {
            return pointsCompare;
          }

          // Desempate:
          // más respuestas correctas
          return (
            Number(b.correct_votes) -
            Number(a.correct_votes)
          );
        }
      );

      // ========================================================
      // POSICIONES
      // ========================================================

      ranking.forEach(
        (player, index) => {
          player.position =
            index + 1;
        }
      );

      // ========================================================
      // DETALLE DE RESPUESTAS
      // ========================================================

      const answerResults = [];

      for (
        const result
        of finalAnswerScores.values()
      ) {
        const answer =
          answers.find(
            item =>
              Number(
                item.round_number
              ) ===
                Number(
                  result.round_number
                ) &&
              item.player_id
                ?.toString()
                .trim() ===
                result.player_id &&
              item.question
                ?.toString()
                .trim() ===
                result.question
          );

        answerResults.push({
          round:
            result.round_number,

          player_id:
            result.player_id,

          player_name:
            answer?.player_name ||
            finalScores[
              result.player_id
            ]?.name ||
            'Jugador',

          question:
            result.question,

          answer:
            answer?.answer
              ?.toString()
              .trim() ||
            '',

          qualification:
            result.qualification,

          points:
            result.points,

          votes_received:
            result.votes_received,

          correcta:
            result.correcta,

          repetida:
            result.repetida,

          mal:
            result.mal
        });
      }

      // ========================================================
      // LOG
      // ========================================================

      console.log('');
      console.log(
        '================================'
      );
      console.log(
        ' RESULTADOS FINALES'
      );
      console.log(
        '================================'
      );
      console.log(
        'SALA:',
        code
      );
      console.log(
        'JUGADORES:',
        players.length
      );
      console.log(
        'RESPUESTAS:',
        answers.length
      );
      console.log(
        'VOTOS NORMALIZADOS:',
        normalizedVoteRows.length
      );
      console.log(
        'RESPUESTAS CALIFICADAS:',
        finalAnswerScores.size
      );

      for (
        const player
        of ranking
      ) {
        console.log(
          `${player.position}. ${player.name} - ${player.points} pts`
        );
      }

      console.log(
        '================================'
      );
      console.log('');

      // ========================================================
      // RESPUESTA
      // ========================================================

      return res.status(200).json({
        success: true,

        room: {
          id:
            room.id,

          room_code:
            room.room_code,

          room_name:
            room.room_name,

          rounds:
            Number(
              room.rounds || 1
            ),

          current_round:
            Number(
              room.current_round || 1
            ),

          status:
            room.status
        },

        total_players:
          players.length,

        total_rounds:
          Number(
            room.rounds || 1
          ),

        ranking:
          ranking,

        answer_results:
          answerResults
      });

    } catch (error) {
      console.error(
        'ERROR RESULTADOS FINALES:',
        error
      );

      return res.status(500).json({
        success: false,

        message:
          'Error obteniendo los resultados finales.',

        error:
          error.message
      });
    }
  }
);

// ============================================================
// ELIMINAR PARTIDA COMPLETA
// ============================================================
//
// DELETE /api/rooms/:roomCode
//
// Elimina:
// - room_round_votes
// - room_round_answers
// - room_players
// - rooms
//
// ============================================================

router.delete(
  '/rooms/:roomCode',
  async (req, res) => {
    const client = await pool.connect();

    try {
      const roomCode =
        req.params.roomCode
          ?.toString()
          .trim()
          .toUpperCase();

      if (!roomCode) {
        return res.status(400).json({
          success: false,
          message:
            'El código de la sala es obligatorio.'
        });
      }

      await client.query('BEGIN');

      // ========================================================
      // BUSCAR SALA
      // ========================================================

      const roomResult =
        await client.query(
          `
          SELECT id, room_code
          FROM rooms
          WHERE UPPER(room_code) = UPPER($1)
          LIMIT 1
          `,
          [roomCode]
        );

      if (roomResult.rows.length === 0) {
        await client.query('ROLLBACK');

        return res.status(404).json({
          success: false,
          message:
            'La sala no existe o ya fue eliminada.'
        });
      }

      const room =
        roomResult.rows[0];

      const roomId =
        room.id;

      // ========================================================
      // ELIMINAR VOTACIONES
      // ========================================================

      const deletedVotes =
        await client.query(
          `
          DELETE FROM room_round_votes
          WHERE room_id = $1
          `,
          [roomId]
        );

      // ========================================================
      // ELIMINAR RESPUESTAS
      // ========================================================

      const deletedAnswers =
        await client.query(
          `
          DELETE FROM room_round_answers
          WHERE room_id = $1
          `,
          [roomId]
        );

      // ========================================================
      // ELIMINAR JUGADORES
      // ========================================================

      const deletedPlayers =
        await client.query(
          `
          DELETE FROM room_players
          WHERE room_id = $1
          `,
          [roomId]
        );

      // ========================================================
      // ELIMINAR SALA
      // ========================================================

      const deletedRoom =
        await client.query(
          `
          DELETE FROM rooms
          WHERE id = $1
          RETURNING id, room_code
          `,
          [roomId]
        );

      await client.query('COMMIT');

      console.log('');
      console.log(
        '================================'
      );
      console.log(
        ' PARTIDA ELIMINADA'
      );
      console.log(
        '================================'
      );
      console.log(
        'SALA:',
        room.room_code
      );
      console.log(
        'ROOM ID:',
        roomId
      );
      console.log(
        'VOTOS ELIMINADOS:',
        deletedVotes.rowCount
      );
      console.log(
        'RESPUESTAS ELIMINADAS:',
        deletedAnswers.rowCount
      );
      console.log(
        'JUGADORES ELIMINADOS:',
        deletedPlayers.rowCount
      );
      console.log(
        'SALA ELIMINADA:',
        deletedRoom.rowCount
      );
      console.log(
        '================================'
      );
      console.log('');

      return res.status(200).json({
        success: true,
        message:
          'La partida y todos sus datos fueron eliminados correctamente.',
        room_id:
          roomId,
        room_code:
          room.room_code,
        deleted: {
          votes:
            deletedVotes.rowCount,
          answers:
            deletedAnswers.rowCount,
          players:
            deletedPlayers.rowCount,
          room:
            deletedRoom.rowCount
        }
      });

    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {}

      console.error(
        'ERROR ELIMINANDO PARTIDA:',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          'No se pudo eliminar la partida.',
        error:
          error.message
      });

    } finally {
      client.release();
    }
  }
);

router.get(
  '/rooms/:roomCode',
  async (req, res) => {
    try {
      const roomCode =
        req.params.roomCode;

      if (
        !roomCode ||
        roomCode.toString().trim() === ''
      ) {
        return res.status(400).json({
          success: false,
          message:
            'El código de sala es obligatorio.'
        });
      }

      const code =
        roomCode
          .toString()
          .trim()
          .toUpperCase();

      const room =
        await getRoomByCode(
          code
        );

      if (!room) {
        return res.status(404).json({
          success: false,
          message:
            'Sala no encontrada.'
        });
      }

      let countdown = 0;
      let locked = false;

      if (
        room.round_locked === true &&
        room.stop_requested_at &&
        room.round_locked_at
      ) {
        const timer =
          getRoundCountdown(
            room.stop_requested_at,
            room.round_locked_at
          );

        countdown =
          timer.countdown;

        locked =
          timer.locked;
      }

      if (
        room.round_locked !== true
      ) {
        countdown = 0;
        locked = false;
      }

      const players =
        await getRoomPlayers(
          room.id
        );

      return res.status(200).json({
        success: true,

        room,

        players,

        countdown,

        locked
      });

    } catch (error) {
      console.error(
        'ERROR OBTENIENDO SALA:',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          'Error al obtener la sala.',
        error:
          error.message
      });
    }
  }
);

// ============================================================
// GUARDAR RESPUESTAS DEL JUGADOR
// ============================================================
//
// Cada dispositivo manda SUS respuestas.
// Se guardan por:
//
// sala + jugador + ronda + pregunta
//
// ============================================================

router.post(
  '/rooms/answers',
  async (req, res) => {
    const client =
      await pool.connect();

    try {
      await ensureAnswersConstraint();

      const roomCode =
        req.body.room_code;

      const playerId =
        req.body.player_id;

      const playerName =
        req.body.player_name;

      const round =
        req.body.round;

      const letter =
        req.body.letter;

      const answers =
        req.body.answers;

      if (
        !roomCode ||
        roomCode.toString().trim() === ''
      ) {
        return res.status(400).json({
          success: false,
          message:
            'El código de sala es obligatorio.'
        });
      }

      if (
        !playerId ||
        playerId.toString().trim() === ''
      ) {
        return res.status(400).json({
          success: false,
          message:
            'El jugador es obligatorio.'
        });
      }

      if (
        round === undefined ||
        round === null
      ) {
        return res.status(400).json({
          success: false,
          message:
            'La ronda es obligatoria.'
        });
      }

      if (!Array.isArray(answers)) {
        return res.status(400).json({
          success: false,
          message:
            'Las respuestas deben ser un arreglo.'
        });
      }

      const code =
        roomCode
          .toString()
          .trim()
          .toUpperCase();

      const cleanPlayerId =
        playerId
          .toString()
          .trim();

      const cleanRound =
        Number(round);

      const cleanLetter =
        letter
          ? letter
              .toString()
              .trim()
              .toUpperCase()
          : '';

      const room =
        await getRoomByCode(
          code
        );

      if (!room) {
        return res.status(404).json({
          success: false,
          message:
            'Sala no encontrada.'
        });
      }

      const playerResult =
        await client.query(
          `
          SELECT
            id,
            room_id,
            player_id,
            player_name
          FROM room_players
          WHERE room_id = $1
            AND player_id = $2
          LIMIT 1
          `,
          [
            room.id,
            cleanPlayerId
          ]
        );

      if (
        playerResult.rows.length === 0
      ) {
        return res.status(403).json({
          success: false,
          message:
            'El jugador no pertenece a esta sala.'
        });
      }

      const databasePlayer =
        playerResult.rows[0];

      const serverRound =
        Number(
          room.current_round || 1
        );

      if (
        cleanRound !==
        serverRound
      ) {
        return res.status(409).json({
          success: false,
          message:
            'La ronda enviada no coincide con la ronda actual.',
          current_round:
            serverRound
        });
      }

      await client.query(
        'BEGIN'
      );

      let savedCount = 0;

      for (
        const item
        of answers
      ) {
        if (
          item === null ||
          typeof item !== 'object'
        ) {
          continue;
        }

        const question =
          item.question !== undefined &&
          item.question !== null
            ? item.question
                .toString()
                .trim()
            : '';

        const answer =
          item.answer !== undefined &&
          item.answer !== null
            ? item.answer
                .toString()
                .trim()
            : '';

        if (
          question === ''
        ) {
          continue;
        }

        await client.query(
          `
          INSERT INTO room_round_answers (
            room_id,
            player_id,
            player_name,
            question,
            answer,
            round_number,
            letter,
            created_at
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            NOW()
          )
          ON CONFLICT (
            room_id,
            player_id,
            round_number,
            question
          )
          DO UPDATE SET
            player_name =
              EXCLUDED.player_name,

            answer =
              EXCLUDED.answer,

            letter =
              EXCLUDED.letter
          `,
          [
            room.id,
            cleanPlayerId,
            playerName &&
            playerName.toString().trim() !== ''
              ? playerName.toString().trim()
              : databasePlayer.player_name ||
                'Jugador',
            question,
            answer,
            cleanRound,
            cleanLetter
          ]
        );

        savedCount++;
      }

      await client.query(
        'COMMIT'
      );

      const allAnswersResult =
        await client.query(
          `
          SELECT
            id,
            room_id,
            player_id,
            player_name,
            question,
            answer,
            round_number,
            letter,
            created_at
          FROM room_round_answers
          WHERE room_id = $1
            AND round_number = $2
          ORDER BY
            player_name ASC,
            id ASC
          `,
          [
            room.id,
            cleanRound
          ]
        );

      console.log('');
      console.log(
        '================================'
      );
      console.log(
        'RESPUESTAS GUARDADAS'
      );
      console.log(
        'SALA:',
        code
      );
      console.log(
        'JUGADOR:',
        cleanPlayerId
      );
      console.log(
        'RONDA:',
        cleanRound
      );
      console.log(
        'LETRA:',
        cleanLetter
      );
      console.log(
        'GUARDADAS:',
        savedCount
      );
      console.log(
        'TOTAL RONDA:',
        allAnswersResult.rows.length
      );
      console.log(
        '================================'
      );
      console.log('');

      return res.status(200).json({
        success: true,

        message:
          'Respuestas guardadas correctamente.',

        room_code:
          code,

        player_id:
          cleanPlayerId,

        round:
          cleanRound,

        letter:
          cleanLetter,

        saved_count:
          savedCount,

        total_round_answers:
          allAnswersResult.rows.length,

        answers:
          allAnswersResult.rows
      });

    } catch (error) {
      try {
        await client.query(
          'ROLLBACK'
        );
      } catch (_) {}

      console.error(
        'ERROR GUARDANDO RESPUESTAS:',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          'Error al guardar las respuestas.',
        error:
          error.message
      });

    } finally {
      client.release();
    }
  }
);

// ============================================================
// RESPUESTAS POR RUTA ESPECÍFICA
//
// GET /api/rooms/PMA2WT/answers/1
// ============================================================

router.get(
  '/rooms/:roomCode/answers/:round',
  async (req, res) => {
    try {
      const roomCode =
        req.params.roomCode;

      const round =
        Number(
          req.params.round
        );

      if (
        !roomCode ||
        roomCode.toString().trim() === ''
      ) {
        return res.status(400).json({
          success: false,
          message:
            'El código de sala es obligatorio.'
        });
      }

      if (
        !Number.isInteger(round) ||
        round <= 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            'La ronda no es válida.'
        });
      }

      const code =
        roomCode
          .toString()
          .trim()
          .toUpperCase();

      const room =
        await getRoomByCode(
          code
        );

      if (!room) {
        return res.status(404).json({
          success: false,
          message:
            'Sala no encontrada.'
        });
      }

      const result =
        await pool.query(
          `
          SELECT
            id,
            room_id,
            player_id,
            player_name,
            question,
            answer,
            round_number,
            letter,
            created_at
          FROM room_round_answers
          WHERE room_id = $1
            AND round_number = $2
          ORDER BY
            player_name ASC,
            id ASC
          `,
          [
            room.id,
            round
          ]
        );

      return res.status(200).json({
        success: true,

        room_code:
          code,

        round,

        total:
          result.rows.length,

        answers:
          result.rows
      });

    } catch (error) {
      console.error(
        'ERROR OBTENIENDO RESPUESTAS:',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          'Error al obtener las respuestas.',
        error:
          error.message
      });
    }
  }
);

// ============================================================
// RESULTADOS FINALES
//
// GET /api/rooms/final-results?room_code=PMA2WT
//
// ============================================================



// ============================================================
// EXPORTAR
// ============================================================

module.exports = router;