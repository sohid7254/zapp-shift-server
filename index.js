const express = require("express");
const app = express();
require("dotenv").config();
const port = process.env.PORT || 3000;
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

// tracking id
const crypto = require("crypto");

const admin = require("firebase-admin");

const serviceAccount = require("./zapp-shift-client-firebase-adminsdk.json");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

function generateTrackingId() {
    const prefix = "PKG";
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const random = crypto.randomBytes(3).toString("hex").toUpperCase();
    return `${prefix}-${date}-${random}`;
}

const stripe = require("stripe")(process.env.STRIPE_SECURE);

// midlewear
app.use(express.json());
app.use(cors());

const verifyFBToken = async (req, res, next) => {
    const token = req.headers.authorization;
    if (!token) {
        return res.status(401).send({ message: "unauthorization " });
    }
    try {
        const idToken = token.split(" ")[1];
        const decoded = await admin.auth().verifyIdToken(idToken);
        console.log("decoded in the token", decoded);
        req.decoded_email = decoded.email;

        next();
    } catch (err) {
        return res.status(401).send({ message: "Unothorizes access" });
    }
};

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.fdcjmvl.mongodb.net/?appName=Cluster0`;
// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    },
});

async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        await client.connect();

        const db = client.db("zap_shift_db");
        const userCollection = db.collection("users");
        const parcelCollection = db.collection("parcels");
        const paymentCollection = db.collection("payments");
        const ridersCollection = db.collection("riders");

        // users api
        app.post("/users", async (req, res) => {
            const user = req.body;
            user.role = "user";
            user.createdAt = new Date();
            const email = user.email;

            const userExists = await userCollection.findOne({ email });
            if (userExists) {
                return res.send({ message: "user exists" });
            }

            const result = await userCollection.insertOne(user);
            res.send(result);
        });

        // Parcel Api

        app.get("/parcels", async (req, res) => {
            const query = {};
            const { email } = req.query;
            if (email) {
                query.senderEmail = email;
            }
            const options = { sort: { createdAt: -1 } };
            const cursor = parcelCollection.find(query, options);
            const result = await cursor.toArray();
            res.send(result);
        });

        // Pay the desired product as you want
        app.get("/parcels/:id", async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await parcelCollection.findOne(query);
            res.send(result);
        });

        app.post("/parcels", async (req, res) => {
            const parcel = req.body;
            // parcel created time
            parcel.createdAt = new Date();
            const result = await parcelCollection.insertOne(parcel);
            res.send(result);
        });

        app.delete("/parcels/:id", async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await parcelCollection.deleteOne(query);
            res.send(result);
        });

        // New payment
        app.post("/payment-checkout-session", async (req, res) => {
            const paymentInfo = req.body;
            const amount = parseInt(paymentInfo.cost) * 100;
            const session = await stripe.checkout.sessions.create({
                line_items: [
                    {
                        // Provide the exact Price ID (for example, price_1234) of the product you want to sell
                        price_data: {
                            currency: "usd",
                            unit_amount: amount,
                            product_data: {
                                name: `Please Pay for ${paymentInfo.parcelName}`,
                            },
                        },
                        quantity: 1,
                    },
                ],
                mode: "payment",
                metadata: {
                    parcelId: paymentInfo.parcelId,
                    parcelName: paymentInfo.parcelName,
                },

                customer_email: paymentInfo.senderEmail,
                success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
            });
            res.send({ url: session.url });
        });

        //old payment method apis
        app.post("/create-checkout-session", async (req, res) => {
            const paymentInfo = req.body;
            const amount = parseInt(paymentInfo.cost) * 100;
            const session = await stripe.checkout.sessions.create({
                line_items: [
                    {
                        price_data: {
                            currency: "USD",
                            unit_amount: amount,
                            product_data: {
                                name: paymentInfo.parcelName,
                            },
                        },

                        quantity: 1,
                    },
                ],
                customer_email: paymentInfo.senderEmail,
                mode: "payment",
                metadata: {
                    parcelId: paymentInfo.parcelId,
                },
                success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success`,
                cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
            });
            console.log(session);
            res.send({ url: session.url });
        });

        app.patch("/payment-succes", async (req, res) => {
            const sessionId = req.query.session_id;
            const session = await stripe.checkout.sessions.retrieve(sessionId);
            // console.log("session retrieve", session);

            const transactionId = session.payment_intent;
            const query = { transactionId: transactionId };

            const paymentExist = await paymentCollection.findOne(query);
            console.log(paymentExist);
            if (paymentExist) {
                return res.send({
                    message: "already exist",
                    transactionId,
                    trackingId: paymentExist.trackingId,
                });
            }

            const trackingId = generateTrackingId();
            if (session.payment_status === "paid") {
                const id = session.metadata.parcelId;
                const query = { _id: new ObjectId(id) };
                const update = {
                    $set: {
                        paymentStatus: "paid",
                        trackingId: trackingId,
                    },
                };
                const result = await parcelCollection.updateOne(query, update);

                const payment = {
                    amount: session.amount_total / 100,
                    currency: session.currency,
                    customerEmail: session.customer_email,
                    parcelId: session.metadata.parcelId,
                    parcelName: session.metadata.parcelName,
                    transactionId: session.payment_intent,
                    paymentStatus: session.payment_status,
                    paidAt: new Date(),
                    trackingId: trackingId,
                };

                if (session.payment_status === "paid") {
                    const resultPayment = await paymentCollection.insertOne(payment);
                    res.send({
                        success: true,
                        modifyParcel: result,
                        trackingId: trackingId,
                        transactionId: session.payment_intent,
                        paymentInfo: resultPayment,
                    });
                }
            }

            res.send({ success: false });
        });
        // payment apis
        app.get("/payments", verifyFBToken, async (req, res) => {
            const email = req.query.email;
            const query = {};
            console.log("heeaders", req.headers);
            if (email) {
                query.customerEmail = email;

                // check email address
                if (email !== req.decoded_email) {
                    return res.status(403).send({ message: "Forbidden access" });
                }
            }

            const cursor = paymentCollection.find(query).sort({ paidAt: -1 });
            const result = await cursor.toArray();
            res.send(result);
        });

        // riders related apis
        app.get('/riders', async(req,res)=> {
            const query= {};
            if(req.query.status){
                query.status = req.queryy.status;
            }
            const cursor = ridersCollection.find(query)
            const result = await cursor.toArray()
            res.send(result);
        })
        // post the rider into db
        app.post("/riders", async (req, res) => {
            const rider = req.body;
            rider.status = "pending";
            rider.createdAt = new Date(); 
            const result = await ridersCollection.insertOne(rider);
            res.send(result);
        });
        // aprove the rider
        app.patch("/riders/:id",verifyFBToken,async(req, res) => {
            const status = req.body.status;
            const id = req.params.id;
            const query = {_id: new ObjectId(id)}
            const updatedDoc = {
                $set: {
                    status: status,
                }
            }

            const result = await ridersCollection.updateOne(query, updatedDoc)
            if(status === 'Aproved'){
                const email = req.body.email;
                const userQuery = {email};
                const updateUser = {
                    $set: {
                        role: 'Rider',
                    }
                    
                }
                const userResult = await userCollection.updateOne(userQuery, updateUser)
                
            }
            res.send(result)
        })

        // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // Ensures that the client will close when you finish/error
        // await client.close();
    }
}
run().catch(console.dir);

app.get("/", (req, res) => {
    res.send("Zapp is shifting....");
});

app.listen(port, () => {
    console.log(`Zapp Is shifting ${port}`);
});
