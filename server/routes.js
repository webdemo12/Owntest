import { createServer } from "http";
import pg from "pg";
import webpush from "web-push";

const { Pool } = pg;

// Configure web-push with VAPID keys
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || 'BMCGbFCVp3-9I01uEpRk0fSjJplMC9T4rzxRn-bkOT6gl1BrY9GdcY92mMKVMzT8z6NlbpNNymA1h5INVlX_zu4';
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY || '0wwLIk9w79_PzdCCgZH0HVh7dCwamZ8jZqgOjP9aXTE';
const vapidEmail = process.env.VAPID_EMAIL || 'mailto:notification@example.com';

webpush.setVapidDetails(vapidEmail, vapidPublicKey, vapidPrivateKey);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function query(text, params) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;
  console.log("Executed query", { text: text.substring(0, 50), duration, rows: result.rowCount });
  return result;
}

async function initDatabase() {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await query(`
      CREATE TABLE IF NOT EXISTS results (
        id SERIAL PRIMARY KEY,
        result_date DATE NOT NULL,
        time_slot VARCHAR(50) NOT NULL,
        number_1 INT NOT NULL,
        number_2 INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(result_date, time_slot)
      )
    `);
    
    await query(`
      CREATE TABLE IF NOT EXISTS contact_submissions (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL,
        phone VARCHAR(20),
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await query(`
      CREATE TABLE IF NOT EXISTS admin_tokens (
        id SERIAL PRIMARY KEY,
        admin_id INT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
        token VARCHAR(255) NOT NULL UNIQUE,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await query(`
      CREATE TABLE IF NOT EXISTS super_game_results (
        id SERIAL PRIMARY KEY,
        result_date DATE NOT NULL,
        time_slot VARCHAR(50) NOT NULL,
        number_1 INT NOT NULL,
        number_2 INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(result_date, time_slot)
      )
    `);
    
    await query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id SERIAL PRIMARY KEY,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT,
        auth TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Insert default admin user if none exists
    const adminCheck = await query("SELECT COUNT(*) as count FROM admin_users");
    if (parseInt(adminCheck.rows[0].count) === 0) {
      await query(
        "INSERT INTO admin_users (username, password) VALUES ($1, $2)",
        ["admin", "admin123"]
      );
      console.log("Default admin user created (username: admin, password: admin123)");
    }
    
    console.log("Database initialized successfully");
  } catch (error) {
    console.error("Failed to initialize database:", error);
  }
}

export async function registerRoutes(app) {
  // Initialize database
  await initDatabase();

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // GET today's results
  app.get("/api/results/today", async (req, res) => {
    try {
      const today = new Date().toISOString().split('T')[0];
      const result = await query(
        "SELECT id, result_date, time_slot, number_1, number_2 FROM results WHERE result_date = $1 ORDER BY time_slot",
        [today]
      );
      res.json(result.rows);
    } catch (error) {
      console.error("Error fetching today's results:", error);
      res.status(500).json({ error: "Failed to fetch results" });
    }
  });

  // GET previous results (last 15 days)
  app.get("/api/results/previous", async (req, res) => {
    try {
      const result = await query(
        "SELECT id, result_date, time_slot, number_1, number_2 FROM results WHERE result_date < CURRENT_DATE ORDER BY result_date DESC, time_slot LIMIT 120"
      );
      res.json(result.rows);
    } catch (error) {
      console.error("Error fetching previous results:", error);
      res.status(500).json({ error: "Failed to fetch results" });
    }
  });

  // GET recent results (last 10 days including today)
  app.get("/api/results/recent", async (req, res) => {
    try {
      const result = await query(
        "SELECT id, result_date, time_slot, number_1, number_2 FROM results WHERE result_date >= CURRENT_DATE - INTERVAL '9 days' ORDER BY result_date DESC, time_slot"
      );
      res.json(result.rows);
    } catch (error) {
      console.error("Error fetching recent results:", error);
      res.status(500).json({ error: "Failed to fetch results" });
    }
  });

  // Search results
  app.get("/api/results/search", async (req, res) => {
    try {
      const { date, number } = req.query;
      let queryStr = "SELECT id, result_date, time_slot, number_1, number_2 FROM results WHERE 1=1";
      const params = [];

      if (date) {
        const dateStr = Array.isArray(date) ? date[0] : date;
        queryStr += " AND result_date = $" + (params.length + 1);
        params.push(dateStr);
      }

      if (number) {
        const numberStr = Array.isArray(number) ? number[0] : number;
        queryStr += " AND (number_1 = $" + (params.length + 1) + " OR number_2 = $" + (params.length + 1) + ")";
        params.push(parseInt(numberStr));
      }

      queryStr += " ORDER BY result_date DESC, time_slot";
      const result = await query(queryStr, params);
      res.json(result.rows);
    } catch (error) {
      console.error("Error searching results:", error);
      res.status(500).json({ error: "Failed to search results" });
    }
  });

  // POST result
  app.post("/api/results", async (req, res) => {
    try {
      const { result_date, time_slot, number_1, number_2 } = req.body;
      
      if (!result_date || !time_slot || number_1 === "" || number_1 === null || number_1 === undefined || number_2 === "" || number_2 === null || number_2 === undefined) {
        return res.status(400).json({ error: "All fields are required" });
      }

      const result = await query(
        "INSERT INTO results (result_date, time_slot, number_1, number_2) VALUES ($1, $2, $3, $4) ON CONFLICT(result_date, time_slot) DO UPDATE SET number_1=$3, number_2=$4 RETURNING id, result_date, time_slot, number_1, number_2",
        [result_date, time_slot, number_1, number_2]
      );
      
      res.status(201).json(result.rows[0]);
    } catch (error) {
      console.error("Error creating result:", error);
      res.status(500).json({ error: "Failed to create result" });
    }
  });

  // DELETE result
  app.delete("/api/results/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const result = await query("DELETE FROM results WHERE id = $1 RETURNING id", [id]);
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Result not found" });
      }

      res.json({ message: "Result deleted successfully" });
    } catch (error) {
      console.error("Error deleting result:", error);
      res.status(500).json({ error: "Failed to delete result" });
    }
  });

  // POST contact submission
  app.post("/api/contact", async (req, res) => {
    try {
      const { name, email, phone, message } = req.body;
      
      if (!name || !email || !message) {
        return res.status(400).json({ error: "Name, email, and message are required" });
      }

      const result = await query(
        "INSERT INTO contact_submissions (name, email, phone, message) VALUES ($1, $2, $3, $4) RETURNING id, name, email, phone, message, created_at",
        [name, email, phone || null, message]
      );
      
      res.status(201).json(result.rows[0]);
    } catch (error) {
      console.error("Error creating contact submission:", error);
      res.status(500).json({ error: "Failed to submit contact form" });
    }
  });

  // GET all contact submissions
  app.get("/api/contact", async (req, res) => {
    try {
      const result = await query(
        "SELECT id, name, email, phone, message, created_at FROM contact_submissions ORDER BY created_at DESC"
      );
      res.json(result.rows);
    } catch (error) {
      console.error("Error fetching contact submissions:", error);
      res.status(500).json({ error: "Failed to fetch submissions" });
    }
  });

  // Admin login
  app.post("/api/admin/login", async (req, res) => {
    try {
      const { username, password } = req.body;
      
      if (!username || !password) {
        return res.status(400).json({ error: "Username and password are required" });
      }

      const result = await query(
        "SELECT id, username FROM admin_users WHERE username = $1 AND password = $2",
        [username, password]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const admin = result.rows[0];
      // Generate a random token
      const token = Math.random().toString(36).substring(2, 40) + Math.random().toString(36).substring(2, 40);
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      
      // Store token in database
      await query(
        "INSERT INTO admin_tokens (admin_id, token, expires_at) VALUES ($1, $2, $3)",
        [admin.id, token, expiresAt]
      );
      
      console.log('🔐 Login successful - Token stored in DB for user:', admin.username);
      res.json({ message: "Login successful", admin, token });
    } catch (error) {
      console.error("Error logging in:", error);
      res.status(500).json({ error: "Failed to login" });
    }
  });

  // Check admin session via token
  app.get("/api/admin/check", async (req, res) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace('Bearer ', '');
    
    if (!token) {
      return res.json({ isAdmin: false });
    }
    
    try {
      // Check if token exists and is not expired
      const result = await query(
        "SELECT at.admin_id, au.username FROM admin_tokens at JOIN admin_users au ON at.admin_id = au.id WHERE at.token = $1 AND at.expires_at > NOW()",
        [token]
      );
      
      if (result.rows.length === 0) {
        return res.json({ isAdmin: false });
      }
      
      res.json({ isAdmin: true, username: result.rows[0].username });
    } catch (error) {
      console.error("Token verification failed:", error.message);
      res.json({ isAdmin: false });
    }
  });

  // Change admin password
  app.post("/api/admin/change-password", async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      const token = authHeader?.replace('Bearer ', '');
      
      if (!token) {
        return res.status(401).json({ error: "Not authorized" });
      }

      // Verify token is valid
      const tokenResult = await query(
        "SELECT admin_id FROM admin_tokens WHERE token = $1 AND expires_at > NOW()",
        [token]
      );
      
      if (tokenResult.rows.length === 0) {
        return res.status(401).json({ error: "Invalid or expired token" });
      }

      const adminId = tokenResult.rows[0].admin_id;
      const { oldPassword, newPassword } = req.body;
      
      if (!oldPassword || !newPassword) {
        return res.status(400).json({ error: "Both passwords are required" });
      }

      if (newPassword.length < 6) {
        return res.status(400).json({ error: "New password must be at least 6 characters" });
      }

      const checkResult = await query(
        "SELECT id FROM admin_users WHERE id = $1 AND password = $2",
        [adminId, oldPassword]
      );

      if (checkResult.rows.length === 0) {
        return res.status(401).json({ error: "Current password is incorrect" });
      }

      await query(
        "UPDATE admin_users SET password = $1 WHERE id = $2",
        [newPassword, adminId]
      );

      res.json({ message: "Password changed successfully" });
    } catch (error) {
      console.error("Error changing password:", error);
      res.status(500).json({ error: "Failed to change password" });
    }
  });

  // GET super game recent results
  app.get("/api/super-game/recent", async (req, res) => {
    try {
      const result = await query(
        "SELECT id, result_date, time_slot, number_1, number_2 FROM super_game_results WHERE result_date >= CURRENT_DATE - INTERVAL '9 days' ORDER BY result_date DESC, time_slot"
      );
      res.json(result.rows);
    } catch (error) {
      console.error("Error fetching super game results:", error);
      res.status(500).json({ error: "Failed to fetch super game results" });
    }
  });

  // POST super game result
  app.post("/api/super-game", async (req, res) => {
    try {
      const { result_date, time_slot, number_1, number_2 } = req.body;
      
      if (!result_date || !time_slot || number_1 === "" || number_1 === null || number_1 === undefined || number_2 === "" || number_2 === null || number_2 === undefined) {
        return res.status(400).json({ error: "All fields are required" });
      }

      const result = await query(
        "INSERT INTO super_game_results (result_date, time_slot, number_1, number_2) VALUES ($1, $2, $3, $4) ON CONFLICT(result_date, time_slot) DO UPDATE SET number_1=$3, number_2=$4 RETURNING id, result_date, time_slot, number_1, number_2",
        [result_date, time_slot, number_1, number_2]
      );
      
      res.status(201).json(result.rows[0]);
    } catch (error) {
      console.error("Error creating super game result:", error);
      res.status(500).json({ error: "Failed to create super game result" });
    }
  });

  // DELETE super game result
  app.delete("/api/super-game/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const result = await query("DELETE FROM super_game_results WHERE id = $1 RETURNING id", [id]);
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Result not found" });
      }

      res.json({ message: "Result deleted successfully" });
    } catch (error) {
      console.error("Error deleting super game result:", error);
      res.status(500).json({ error: "Failed to delete super game result" });
    }
  });

  // Admin logout
  app.post("/api/admin/logout", async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      const token = authHeader?.replace('Bearer ', '');
      
      if (token) {
        // Delete token from database (revoke it)
        await query("DELETE FROM admin_tokens WHERE token = $1", [token]);
        console.log('🔐 Token revoked - User logged out');
      }
      
      res.json({ message: "Logout successful" });
    } catch (error) {
      console.error("Error logging out:", error);
      res.status(500).json({ error: "Failed to logout" });
    }
  });

  // ==================== PUSH NOTIFICATION ROUTES ====================

  // Get VAPID public key for client
  app.get("/api/vapid-public-key", (req, res) => {
    res.json({ publicKey: vapidPublicKey });
  });

  // Serve service worker
  app.get("/service-worker.js", (req, res) => {
    res.setHeader("Content-Type", "application/javascript");
    res.send(`
self.addEventListener('push', (event) => {
  console.log('Push notification received:', event);
  
  let notificationData = {
    title: 'M3 Matka Notification',
    body: 'You have a new message',
    icon: '/ganesh.png'
  };

  if (event.data) {
    try {
      notificationData = event.data.json();
    } catch (e) {
      notificationData.body = event.data.text();
    }
  }

  event.waitUntil(
    self.registration.showNotification(notificationData.title, {
      body: notificationData.body,
      icon: notificationData.icon || '/ganesh.png',
      badge: '/ganesh.png',
      vibrate: [200, 100, 200],
      requireInteraction: true
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  console.log('Notification clicked:', event);
  event.notification.close();
  
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((clientList) => {
      for (let i = 0; i < clientList.length; i++) {
        if ('focus' in clientList[i]) {
          return clientList[i].focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow('/');
      }
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
    const { title, options } = event.data;
    self.registration.showNotification(title, options);
  }
});
    `);
  });

  // Subscribe to push notifications
  app.post("/api/push/subscribe", async (req, res) => {
    try {
      const subscription = req.body;
      console.log('[Subscribe] Request received:', { endpoint: subscription?.endpoint ? 'exists' : 'missing', keysExist: subscription?.keys ? 'yes' : 'no' });
      
      if (!subscription || !subscription.endpoint) {
        console.log('[Subscribe] ERROR: Invalid subscription data');
        return res.status(400).json({ error: "Invalid subscription" });
      }

      // Extract keys from subscription
      const { endpoint } = subscription;
      const p256dh = subscription.keys?.p256dh || '';
      const auth = subscription.keys?.auth || '';

      // Check if already subscribed
      const existing = await query(
        "SELECT id FROM push_subscriptions WHERE endpoint = $1",
        [endpoint]
      );

      if (existing.rows.length === 0) {
        await query(
          "INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES ($1, $2, $3)",
          [endpoint, p256dh, auth]
        );
        console.log('[Subscribe] ✅ New subscription added');
      } else {
        // Update existing subscription
        await query(
          "UPDATE push_subscriptions SET p256dh = $2, auth = $3 WHERE endpoint = $1",
          [endpoint, p256dh, auth]
        );
        console.log('[Subscribe] ✅ Subscription updated');
      }

      const countResult = await query("SELECT COUNT(*) as count FROM push_subscriptions");
      console.log('[Subscribe] ✅ Total subscriptions:', countResult.rows[0].count);
      
      res.json({ success: true, message: 'Subscribed to push notifications' });
    } catch (error) {
      console.error('[Subscribe] ❌ Error:', error.message);
      res.status(500).json({ error: "Failed to subscribe: " + error.message });
    }
  });

  // Get subscription count
  app.get("/api/push/count", async (req, res) => {
    try {
      const result = await query("SELECT COUNT(*) as count FROM push_subscriptions");
      res.json({ count: parseInt(result.rows[0].count) });
    } catch (error) {
      console.error("Error getting subscription count:", error);
      res.status(500).json({ error: "Failed to get count" });
    }
  });

  // Send notification to all subscribed users
  app.post("/api/push/send", async (req, res) => {
    try {
      const { title, message } = req.body;

      if (!title) {
        return res.status(400).json({ error: 'Title is required' });
      }

      if (!message) {
        return res.status(400).json({ error: 'Message is required' });
      }

      // Get all subscriptions from database
      const subsResult = await query("SELECT endpoint, p256dh, auth FROM push_subscriptions");
      const subscriptions = subsResult.rows;

      if (subscriptions.length === 0) {
        return res.status(400).json({ error: 'No subscriptions available' });
      }

      const notificationPayload = JSON.stringify({
        title: title,
        body: message,
        icon: '/ganesh.png'
      });

      let successCount = 0;
      let failCount = 0;

      // Send to all subscriptions
      const promises = subscriptions.map(async (sub) => {
        const pushSubscription = {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth
          }
        };

        try {
          await webpush.sendNotification(pushSubscription, notificationPayload);
          successCount++;
        } catch (error) {
          console.error('[WebPush] Error:', error.statusCode, error.message);
          failCount++;
          // Remove invalid subscriptions (410 Gone or 404 Not Found)
          if (error.statusCode === 410 || error.statusCode === 404) {
            await query("DELETE FROM push_subscriptions WHERE endpoint = $1", [sub.endpoint]);
            console.log('[WebPush] Removed invalid subscription');
          }
        }
      });

      await Promise.all(promises);

      console.log('[Send] Notifications sent - Success:', successCount, 'Failed:', failCount);
      res.json({ 
        success: true, 
        message: `Notifications sent to ${successCount} subscriber(s)`,
        successCount,
        failCount
      });
    } catch (error) {
      console.error('[Send] Error:', error);
      res.status(500).json({ error: 'Failed to send notifications' });
    }
  });

  // ==================== END PUSH NOTIFICATION ROUTES ====================

  const httpServer = createServer(app);

  return httpServer;
}
