function addRow() {
    var rowsContainer = document.getElementById("rowsContainer");
    const template = document.getElementById("rowTemplate").content;
    const newRow = document.importNode(template, true);

    const nameField = newRow.querySelector("#nameField");
    nameField.value = "Player " + (rowsNumber + 1);
    const rowElement = newRow.querySelector(".playerRow");
    rowElement.dataset.rowNumber = rowsNumber;

    players.push({
        name: nameField,
        buyIns: newRow.querySelector("#buyinsField"),
        chips: newRow.querySelector("#chipsField"),
        delta: newRow.querySelector("#deltaField"),
    });

    rowsContainer.appendChild(newRow);
    rowsNumber++;

    recalculate();
}

function removeRow(row) {
    var rowsContainer = document.getElementById("rowsContainer");
    rowsContainer.removeChild(row);
    players.splice(row.dataset.rowNumber, 1);
    rowsNumber--;
    recalculate();
}

function recalculate() {
    const buyInSize = parseFloat(buyInSizeField.value);
    const buyInChips = parseInt(buyInChipsField.value);

    var totalBuyIns = 0;
    var totalChips = 0;
    var totalDelta = 0;
    for (var i = 0; i < rowsNumber; i++) {
        var playerBuyIns = parseInt(players[i].buyIns.value);
        totalBuyIns += playerBuyIns;

        var chips = parseInt(players[i].chips.value);
        totalChips += chips;

        var delta = (chips / buyInChips - playerBuyIns) * buyInSize;
        totalDelta += delta;
        players[i].delta.value = delta.toFixed(2);
    }

    totalBuyInsField.innerHTML = totalBuyIns;
    totalChipsField.innerHTML = totalChips;
    totalDeltaField.innerHTML = totalDelta.toFixed(2);

    saveState();
}

function saveState() {
    const state = {};
    state.buyInSize = parseFloat(buyInSizeField.value);
    state.buyInChips = parseInt(buyInChipsField.value);
    state.players = [];

    for (var i = 0; i < rowsNumber; i++) {
        const playerName = players[i].name.value;
        const playerBuyIns = parseInt(players[i].buyIns.value);
        const chips = parseInt(players[i].chips.value);

        state.players.push({
            name: playerName,
            buyIns: playerBuyIns,
            chips: chips,
        });
    }

    sessionStorage.setItem("poker_state", JSON.stringify(state));
}

function loadState() {
    if (sessionStorage.getItem("poker_state") != null) {
        const loadedState = JSON.parse(sessionStorage.getItem("poker_state"));
        buyInSizeField.value = loadedState.buyInSize;
        buyInChipsField.value = loadedState.buyInChips;

        for (var i = 0; i < loadedState.players.length; i++) {
            addRow();
            players[i].name.value = loadedState.players[i].name;
            players[i].buyIns.value = loadedState.players[i].buyIns;
            players[i].chips.value = loadedState.players[i].chips;
        }
        rowsNumber = loadedState.players.length;
    } else {
        addRow();
    }
    recalculate();
}

function solve() {
    // First - drop all players with non-zero delta
    var playersWithDeltas = players.filter(player => parseFloat(player.delta.value) != 0);
    console.log(playersWithDeltas);

    // Then - sort them by delta
    playersWithDeltas.sort((a, b) => parseFloat(a.delta.value) - parseFloat(b.delta.value));

    const debts = [];
    const debtorNames = [];
    const credits = [];
    const creditorNames = [];
    for (var i = 0; i < playersWithDeltas.length; i++) {
        const delta = parseFloat(playersWithDeltas[i].delta.value);
        if (delta < 0) {
            debts.push(-delta);
            debtorNames.push(playersWithDeltas[i].name.value);
        } else {
            credits.push(delta);
            creditorNames.push(playersWithDeltas[i].name.value);
        }
    }

    const transfersContainer = document.getElementById("transfersContainer");
    const template = document.getElementById("transferTemplate").content;
    const children = [];
    while (debts.length > 0 || credits.length > 0) {
        const transferAmount = Math.min(debts[0], credits[credits.length - 1]);

        const newTransfer = document.importNode(template, true);
        newTransfer.querySelector("#fromPlayerField").innerHTML = debtorNames[0];
        newTransfer.querySelector("#toPlayerField").innerHTML = creditorNames[creditorNames.length - 1];
        newTransfer.querySelector("#amountField").innerHTML = transferAmount.toFixed(2);
        children.push(newTransfer);

        debts[0] -= transferAmount;
        if (debts[0] <= 0.0001) {
            debts.shift();
            debtorNames.shift();
        }

        credits[credits.length - 1] -= transferAmount;
        if (credits[credits.length - 1] <= 0.0001) {
            credits.pop();
            creditorNames.pop();
        }
    }
    transfersContainer.replaceChildren(...children);
}

var rowsNumber = 0;
const players = Array();
const buyInSizeField = document.getElementById("buyInSizeField");
const buyInChipsField = document.getElementById("buyInChipsField");
const totalBuyInsField = document.getElementById("totalBuyInsField");
const totalChipsField = document.getElementById("totalChipsField");
const totalDeltaField = document.getElementById("totalDeltaField");

loadState();
