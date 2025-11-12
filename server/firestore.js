import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
}

const db = admin.firestore();

export async function submitOrder(orderData) {
  const counterRef = db.collection("meta").doc("counter");
  let newOrderId;
  await db.runTransaction(async (t) => {
    const doc = await t.get(counterRef);
    let counter = (doc.exists ? doc.data().count : 0) + 1;
    newOrderId = counter.toString().padStart(4, "0");
    t.set(counterRef, { count: counter });
  });

  orderData.orderId = newOrderId;
  const orderRef = db.collection("orders").doc();
  await orderRef.set({
    orderId: orderData.orderId,
    totalAmount: orderData.totalAmount,
    paymentType: orderData.paymentType,
    timestamp: new Date().toISOString(),
    status: orderData.paymentType === "Venmo" ? "pending" : "paid",
  });

  const batch = db.batch();
  orderData.items.forEach((item) => {
    const txRef = db.collection("transactions").doc();
    batch.set(txRef, {
      orderId: orderData.orderId,
      item: item.name,
      quantity: item.qty,
      total: item.price * item.qty,
    });
  });
  await batch.commit();

  return orderData;
}

export async function getOrders() {
  const snapshot = await db.collection("orders").get();
  return snapshot.docs.map((doc) => doc.data());
}
