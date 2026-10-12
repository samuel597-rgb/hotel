import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import express from 'express';
import multer from 'multer';
import { db, withTransaction } from './sqlite.js';
import { requireCustomer } from './auth.js';
import { logAction } from './audit.js';

const router=express.Router(),scrypt=promisify(crypto.scrypt);
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:2*1024*1024,files:1},fileFilter:(_req,file,done)=>['image/jpeg','image/png','image/webp'].includes(file.mimetype)?done(null,true):done(new Error('Only JPG, PNG, or WEBP images are accepted.'))});
const uploadsDir=path.resolve(process.env.UPLOAD_DIR||path.join(process.cwd(),'uploads'));
const safeEmail=value=>String(value||'').trim().toLowerCase();
const publicEmail=value=>String(value||'').endsWith('@no-email.hoteli.local')?'':value;
const summary=customer=>({id:customer.id,name:customer.name,username:customer.username||'',phone:customer.phone,email:publicEmail(customer.email),address:customer.address||'',landmark:customer.landmark||'',avatarPath:customer.avatar_path||'',role:'customer'});
const phone=value=>String(value||'').replace(/[^+\d]/g,'').slice(0,20);
const emailRe=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const passwordHash=async value=>{const salt=crypto.randomBytes(16).toString('hex'),hash=await scrypt(String(value),salt,64);return {salt,hash:hash.toString('hex')};};
const checkPassword=async(value,customer)=>{const actual=await scrypt(String(value||''),customer.salt,64),expected=Buffer.from(customer.password_hash,'hex');return actual.length===expected.length&&crypto.timingSafeEqual(actual,expected);};

router.get('/api/customer/profile',requireCustomer,(req,res)=>res.json({user:summary(req.customer)}));
router.put('/api/customer/profile',requireCustomer,(req,res)=>{
  const name=String(req.body?.name||'').trim().replace(/\s+/g,' ').slice(0,120),username=String(req.body?.username||'').trim().toLowerCase().replace(/\s+/g,'').slice(0,40),phoneValue=phone(req.body?.phone),email=safeEmail(req.body?.email),address=String(req.body?.address||'').trim().slice(0,1000),landmark=String(req.body?.landmark||'').trim().slice(0,300);
  if(name.length<2||phoneValue.replace(/\D/g,'').length<7||email&&!emailRe.test(email)||username&&!/^[a-z0-9_.-]{3,40}$/.test(username))return res.status(400).json({error:'Check your name, phone, email, and username.'});
  const storedEmail=email||`customer+${req.customer.id}@no-email.hoteli.local`;
  try{withTransaction(()=>{db.prepare('UPDATE customers SET name=?,username=?,phone=?,email=?,address=?,landmark=? WHERE id=?').run(name,username||null,phoneValue,storedEmail,address,landmark,req.customer.id);logAction(db,{actorId:req.customer.id,actorRole:'customer',action:'customer.profile.update',targetType:'customer',targetId:req.customer.id});});}
  catch(error){if(String(error.code).startsWith('SQLITE_CONSTRAINT'))return res.status(409).json({error:'That phone number, email, or username is already in use.'});throw error;}
  return res.json({user:summary(db.prepare('SELECT * FROM customers WHERE id=?').get(req.customer.id))});
});
router.post('/api/customer/profile/password',requireCustomer,async(req,res,next)=>{
  try{const current=String(req.body?.currentPassword||''),nextPassword=String(req.body?.newPassword||'');if(nextPassword.length<8||nextPassword.length>128)return res.status(400).json({error:'New password must be 8 to 128 characters.'});if(!await checkPassword(current,req.customer))return res.status(401).json({error:'Current password is incorrect.'});const hash=await passwordHash(nextPassword);withTransaction(()=>{db.prepare('UPDATE customers SET password_hash=?,salt=? WHERE id=?').run(hash.hash,hash.salt,req.customer.id);logAction(db,{actorId:req.customer.id,actorRole:'customer',action:'customer.password.change',targetType:'customer',targetId:req.customer.id});});return res.json({success:true});}catch(error){return next(error);}
});
router.post('/api/customer/profile/avatar',requireCustomer,upload.single('avatar'),async(req,res,next)=>{
  try{if(!req.file)return res.status(400).json({error:'Choose an image to upload.'});const ext={ 'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp'}[req.file.mimetype];const dir=path.join(uploadsDir,'customers',String(req.customer.id));fs.mkdirSync(dir,{recursive:true});const filename=`avatar${ext}`,target=path.join(dir,filename),relative=`/uploads/customers/${encodeURIComponent(req.customer.id)}/${filename}`;fs.writeFileSync(target,req.file.buffer,{flag:'w'});const old=req.customer.avatar_path;withTransaction(()=>{db.prepare('UPDATE customers SET avatar_path=? WHERE id=?').run(relative,req.customer.id);logAction(db,{actorId:req.customer.id,actorRole:'customer',action:'customer.profile.avatar',targetType:'customer',targetId:req.customer.id});});if(old&&old.startsWith(`/uploads/customers/${req.customer.id}/`)&&old!==relative)fs.rmSync(path.resolve(uploadsDir,`customers/${req.customer.id}`,path.basename(old)),{force:true});return res.json({user:summary(db.prepare('SELECT * FROM customers WHERE id=?').get(req.customer.id))});}catch(error){return next(error);}
});
export default router;
