const path = require('path');

// Mock server instance for testing
let mockServer = null;
let mockIo = null;

// Factory function to create server app for testing
function createTestApp(serverPath = '../server.js') {
  // Clear the require cache to ensure fresh imports
  Object.keys(require.cache).forEach(key => {
    if (key.includes('server') || key.includes('src/') || key.includes('memoryService') || key.includes('pricingService')) {
      delete require.cache[key];
    }
  });

  // Set NODE_ENV to test
  process.env.NODE_ENV = 'test';

  // Import the server file
  const serverModule = require(serverPath);
  const app = serverModule.app || serverModule;
  
  // Use the exported server if available, otherwise create one
  if (serverModule.server) {
    mockServer = serverModule.server;
    // Extract io from the server if possible
    mockIo = mockServer._io || require('socket.io')(mockServer);
  } else if (!mockServer) {
    const http = require('http');
    const socketIo = require('socket.io');
    
    mockServer = http.createServer(app);
    mockIo = socketIo(mockServer, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST']
      }
    });
  }

  return { app, server: mockServer, io: mockIo };
}

// Helper to close server after tests
function closeTestServer(server) {
  return new Promise((resolve) => {
    if (server && server.close) {
      server.close(() => {
        mockServer = null;
        mockIo = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

// Helper to clear all mocks
function clearAllMocks() {
  jest.clearAllMocks();
}

module.exports = {
  createTestApp,
  closeTestServer,
  clearAllMocks
};