import crypto from 'node:crypto';

export function logAction(db, {actorId=null, actorRole='system', action, targetType='', targetId='', meta={}}) {
  db.prepare(`INSERT INTO audit_logs(actor_id,actor_role,action,target_type,target_id,meta_json)
    VALUES(?,?,?,?,?,?)`).run(actorId,actorRole,action,targetType,String(targetId||''),JSON.stringify(meta||{}));
  return db.prepare('SELECT last_insert_rowid() AS id').get().id;
}

export const auditId = () => crypto.randomUUID();
