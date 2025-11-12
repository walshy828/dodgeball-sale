import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { submitOrder, getOrders } from "./firestore.js";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

app.post("/api/orders", async (req, res) => {
  try {
    const result = await submitOrder(req.body);
    res.json(result);
  } catch (err) {
    console.error("Submit order failed:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/orders", async (_req, res) => {
  try {
    const orders = await getOrders();
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
