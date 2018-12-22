function startApp() {
  var tempo = document.getElementById("tempo").value;
  var element = document.getElementById("tempo-menu");
  element.parentNode.removeChild(element);

  var canvas = document.createElement("canvas");
  var minSide = Math.min(document.documentElement.clientWidth,
                         document.documentElement.clientHeight);
  canvas.width = minSide;
  canvas.height = minSide;
  document.body.insertBefore(canvas, document.body.childNodes[0]);

  var context = canvas.getContext("2d");

  var id = 0;
  window.setInterval(function() {
    context.clearRect(0, 0, canvas.width, canvas.height);

    context.lineWidth = 5;
    for (var a = 0; a < 5; ++a) {
      context.beginPath();
      context.moveTo(0.1 * canvas.width, 0.1 * canvas.height * a + 0.2 * canvas.height);
      context.lineTo(0.9 * canvas.width, 0.1 * canvas.height * a + 0.2 * canvas.height);
      context.stroke();
    }

    var noteId = Math.floor(Math.random() * 11);
    context.beginPath();
    var arcCenterX = 0.4 * canvas.width + 0.2 * canvas.width * id;
    var arcCenterY = 0.15 * canvas.height + 0.05 * canvas.height * noteId;
    context.arc(arcCenterX, arcCenterY, 17, 0, 2 * Math.PI);
    context.moveTo(arcCenterX + 17, arcCenterY);
    var topY = arcCenterY - 105;
    if (noteId < 5) {
      topY = arcCenterY + 105;
    }
    context.lineTo(arcCenterX + 17, topY);
    context.stroke();

    id += 1;
    id %= 2;
  }, 1000 * 60 / tempo);

}
