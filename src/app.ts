/* eslint-disable no-console */
import fs from 'node:fs';
import handlebars from 'handlebars';
import he from 'he';
import mjml2html from 'mjml';
import { createTransport } from 'nodemailer';
import pm2 from 'pm2';
import { EventEmitter } from 'node:stream';
import { promisify } from 'node:util';

import { config } from './config.js';
import { Target, Packet, Log, QData } from './types.js';

// Compile the email template once at startup
const template = handlebars.compile(fs.readFileSync(config.template, 'utf8'));
// Create the mail transporter
const transporter = createTransport(config.smtp, { ...config.mail });

// Verify SMTP connection before starting the app
async function verifySmtpConnection() {
  try {
    await transporter.verify();
    console.log('SMTP server is ready to take messages');
  } catch (err) {
    console.error('SMTP connection failed:', err);
    process.exit(1);
  }
}

// List of PM2 log event types to listen for
const eventTypes = <[Target]>Object.keys(config.target);
// Queue for each event type
const queues = <Record<Target, QData[]>>{};
let mailTimeout: NodeJS.Timer | null = null;

eventTypes.forEach((event: Target) => {
  queues[event] = [];
});

// Helper: Aggregate logs from queues for all events
function aggregateLogs(): Log[] {
  const logs: Log[] = [];
  for (const [event, qdata] of Object.entries(queues)) {
    const content: Record<string, string> = {};
    for (const data of qdata.splice(0, qdata.length)) {
      content[data.name] = content[data.name] || '';
      content[data.name] += data.message;
    }
    for (const [name, message] of Object.entries(content)) {
      logs.push({ name: `${name} ${event}`, message: he.encode(message) });
    }
  }
  return logs;
}

// Send an email with aggregated logs for a given event
async function sendMail(eventName: Target): Promise<void> {
  try {
    const logs = aggregateLogs();
    const content = template({ logs });
    const { errors, html } = mjml2html(content);
    if (errors.length > 0) {
      throw new Error(JSON.stringify(errors));
    }
    const info = await transporter.sendMail({ subject: `${eventName || 'log:err'}-${config.mail.subject}`, html });
    console.log('SendMail', info);
  } catch (err) {
    console.error('Error sending mail:', err);
  } finally {
    mailTimeout = null;
  }
}

// Handle a PM2 log event, queueing or sending mail as needed
function handleEvent(event: Target, packet: Packet): void {
  if (!config.target[event].includes(packet.process.name)) {
    return;
  }
  queues[event].push({
    event,
    name: packet.process.name,
    message: packet.data,
  });
  if (event === 'log:err') {
    if (!mailTimeout) {
      // Debounce error emails
      mailTimeout = setTimeout(() => sendMail(event), config.timeout);
    }
  } else if (packet.data.includes('BROADCST:EMAIL')) {
    // Immediate send for broadcast trigger
    void sendMail(event);
  }
}

// Main async startup
(async (): Promise<void> => {
  // Check SMTP connection first
  await verifySmtpConnection();

  // Connect to PM2
  await promisify(pm2.connect).bind(pm2)();
  console.log('[PM2] Log streaming connected');

  // Launch the PM2 event bus
  const bus = <EventEmitter> await promisify(pm2.launchBus).bind(pm2)();
  console.log('[PM2] Log streaming launched');

  // Listen for each event type
  for (const event of eventTypes) {
    console.log(`[PM2] ${event} streaming started`);
    bus.on(event, (packet: Packet) => handleEvent(event, packet));
  }
})().catch((err) => {
  console.error('Fatal error:', err);
});
