exports.drive = (m) => {

    m.functionCall(0, 0);

    m.push(false);

    m.functionCall(5, 5);

    m.push(false);

    m.writeVar("a");

    m.push(false);

    m.push(false);

    m.push(false);

    m.writeProperty("obj0", "2a");

    m.writeProperty("obj0", "y");

    m.writeProperty("obj0", "x");

    m.push(false);

    m.writeVar("b");

    m.readVar("b");

    m.readVar("a");

    m.writeProperty("obj0", "y");

    m.readVar("b");

    m.readProperty("obj0", "y");

    m.writeVar("z");

    m.endExecution();

}
