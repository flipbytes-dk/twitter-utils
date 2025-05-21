// groups.js
import { db } from '@/lib/firebase/admin';

export const getTweetGroup = async groupId => {
  const group = await db.collection('tweet_groups').doc(groupId).get();

  if (!group.exists) {
    return null;
  }
  return group.data();
};
