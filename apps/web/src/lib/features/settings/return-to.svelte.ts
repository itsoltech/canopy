/** Where closing Settings goes back to: the last page outside Settings (default: new thread). */
class ReturnTo {
  url = $state("/");
}

export const returnTo = new ReturnTo();
