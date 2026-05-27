const express = require('express');
const cors = require('cors');
require('dotenv').config();

const usersRouter = require('./routes/users');
const authRouter  = require('./routes/auth');
const ridesRouter         = require('./routes/rides');
const notificationsRouter = require('./routes/notifications');
const driverRouter        = require('./routes/driver');
const adminRouter         = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 5001;

app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:3000'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json());

app.use('/api/auth', authRouter);
app.use('/api/rides',         ridesRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/users',         usersRouter);
app.use('/api/driver',        driverRouter);
app.use('/api/admin',         adminRouter);

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
