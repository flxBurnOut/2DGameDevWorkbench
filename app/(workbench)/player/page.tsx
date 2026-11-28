import { redirect } from 'next/navigation';

/**
 * The character overview only repeated the two tool cards that the home page
 * already shows. The route stays so old links and the production-line entry
 * still land somewhere useful.
 */
export default function PlayerPage() {
  redirect('/');
}
