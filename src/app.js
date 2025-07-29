const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const DebateManager = require('./debate-manager');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// 健康检查端点
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    port: PORT 
  });
});


// 存储活跃的辩论会话
const activeSessions = new Map();

io.on('connection', (socket) => {
  console.log('用户连接:', socket.id);

  socket.on('start-debate', async (data) => {
    const { question, cognitoModel, museModel, apiConfig } = data;
    
    try {
      const debateManager = new DebateManager(apiConfig, socket);
      activeSessions.set(socket.id, debateManager);
      
      await debateManager.startDebate(question, cognitoModel, museModel);
    } catch (error) {
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('stop-debate', () => {
    const debateManager = activeSessions.get(socket.id);
    if (debateManager) {
      debateManager.stopDebate();
    }
  });

  socket.on('force-end-debate', async () => {
    const debateManager = activeSessions.get(socket.id);
    if (debateManager) {
      await debateManager.forceEndDebate();
    }
  });

  socket.on('reset-debate', () => {
    const debateManager = activeSessions.get(socket.id);
    if (debateManager) {
      debateManager.resetDebate();
    }
  });

  socket.on('resume-debate', async () => {
    const debateManager = activeSessions.get(socket.id);
    if (debateManager) {
      try {
        await debateManager.resumeDebate();
      } catch (error) {
        socket.emit('error', { message: error.message });
      }
    }
  });

  socket.on('disconnect', () => {
    console.log('用户断开连接:', socket.id);
    activeSessions.delete(socket.id);
  });
});


const PORT = process.env.PORT || 3003;
server.listen(PORT, () => {
  console.log(`服务器运行在端口 ${PORT}`);
});