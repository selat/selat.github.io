function startApp() {
  var tempo = document.getElementById("tempo").value;
  var element = document.getElementById("tempo-menu");
  element.parentNode.removeChild(element);

  var canvas = document.createElement("canvas");
  canvas.width = 500;
  canvas.height = 500;
  document.body.insertBefore(canvas, document.body.childNodes[0]);

  var context = canvas.getContext("2d");

  var id = 0;
  window.setInterval(function() {
    context.clearRect(0, 0, 500, 500);

    context.lineWidth = 5;
    for (var a = 0; a < 5; ++a) {
      context.beginPath();
      context.moveTo(50, 50 * a + 100);
      context.lineTo(450, 50 * a + 100);
      context.stroke();
    }

    var noteId = Math.floor(Math.random() * 11);
    context.beginPath();
    context.arc(200 + 100 * id, 75 + 25 * noteId, 17, 0, 2 * Math.PI);
    context.moveTo(200 + 100 * id + 17, 75 + 25 * noteId);
    var topY = 75 + 25 * noteId - 105;
    if (noteId < 5) {
      topY = 75 + 25 * noteId + 105;
    }
    context.lineTo(200 + 100 * id + 17, topY);
    context.stroke();

    id += 1;
    id %= 2;
  }, 1000 * 60 / tempo);

}
