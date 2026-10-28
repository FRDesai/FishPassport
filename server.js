const express = require('express');
const path = require('path');
// const QRcode = require('qrcode');
// const db = require('./db');
// const {buildEpcis} = require('./epcis');
// const {createLanding, newId}=require('./landings');
// const {isPin, hashPin,checkPin,newToken}=require('./auth');
// const {baseUrl} = require('./baseurl');

const BUYER_ROLES =['trader','processor','retailer','transporter'];
const SESSION_DAYS=30

const PORT = process.env.PORT||3000;
const app=express();
app.set('trust proxy',true);
app.use(express.json());
app.use(express.static(path.join(__dirname,'public')));
const ivr = require('./ivr');
ivr(app);


const prefixOf = id => id.split('-')[1] || 'KAR';
const parseEvent = e => ({...e,data: JSON.parse(e.data || '{}')});
const round2 = n => Math.round(n*100)/100;
const closeEnough =(a,b) => Math.abs(a-b) <= Math.max(0.5,0.02 * Math.max(a,b));  //2% or 5kg difference

const  q= 
{
    
}








app.listen(PORT,()=>{
    console.log('running...')
});