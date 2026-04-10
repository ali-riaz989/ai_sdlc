require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const http = require('http');
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');

const { testConnection } = require('./config/database');
const logger = require('./utils/logger');
const errorHandler = require('./middleware/errorHandler');

const authRoutes = require('./routes/auth');
const projectRoutes = require('./routes/projects');
const changeRequestRoutes = require('./routes/changeRequests');

const app = express();
const server = http.createServer(app);

const io = socketIo(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    methods: ['GET', 'POST']
  }
});

// Middleware
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:3000' }));
app.use(express.json({ limit: '10mb' }));
app.use(morgan('combined', { stream: { write: message => logger.info(message.trim()) } }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/change-requests', changeRequestRoutes);

// Error handling
app.use(errorHandler);

// Socket.io: authenticate connections via JWT
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    socket.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (e) {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  logger.info('Client connected', { socketId: socket.id, user: socket.user?.email });

  socket.on('subscribe:change-request', (requestId) => {
    socket.join(`cr-${requestId}`);
    logger.info('Subscribed to change request', { requestId, socketId: socket.id });
  });

  socket.on('subscribe:project-setup', (projectId) => {
    socket.join(`project-setup-${projectId}`);
    // Flush buffered logs to late subscribers
    const logBuffer = require('./utils/logBuffer');
    const buffered = logBuffer.get(projectId) || [];
    buffered.forEach(entry => socket.emit('project:log', entry));
  });

  socket.on('project:answer', ({ projectId, answer }) => {
    const pending = require('./utils/pendingQuestions');
    const entry = pending.get(projectId);
    if (entry) {
      clearTimeout(entry.timeout);
      pending.delete(projectId);
      entry.resolve(answer);
    }
  });

  socket.on('disconnect', () => {
    logger.info('Client disconnected', { socketId: socket.id });
  });
});

app.set('io', io);

const PORT = process.env.PORT || 3001;

async function startServer() {
  try {
    await testConnection();
    server.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`);
      console.log(`✓ Server running on http://localhost:${PORT}`);
      console.log(`✓ Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (error) {
    logger.error('Failed to start server', { error: error.message });
    process.exit(1);
  }
}

startServer();

module.exports = { app, io };
