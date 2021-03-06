var fs = require('fs'),
    net = require('net'),
    email = require('emailjs'),
    spawn = require('child_process').spawn,
    exec = require('child_process').exec,
    EventEmitter = require('events').EventEmitter,
    daemon = require('daemon'),
    keepAliveInterval,
    configFilePath,
    DEFAULT_SERVER_SOCK = '/tmp/restarter.sock',
    globalLogger;

function logAppender(logFile) {
  return function(data) {
    fs.open(logFile, 'a+', function(err, fd) {
      if (!err) {
        fs.write(fd, data, null, data.length, null, function(err, written) {
            if(err) throw err;
            fs.close(fd, function(err) {
              if(err) throw err;
            });
        });
      }
    });
  };
}

// function modified from Charlie Robbins' "forever" package:
function checkProcess(pids, callback) {
  var processChecker = spawn('ps', pids, {env: process.env});
  if (processChecker.stdout) {
    var pidMatches = {};
    processChecker.on('exit', function() {
      callback(pidMatches);
    });
    processChecker.stdout.on('data', function(data) {
      if (data) {
        data.toString().split('\n').forEach(function(line) {
          var matches = line.match(/^\s*(\d+)/);
          if (matches && matches.length > 0) {
            pidMatches[matches[1]] = true;
          }
        });
      }
    });
    processChecker.stdout.end();
  }
}

function readConfig(cb) {
  if (fs.statSync(configFilePath).isFile()) {
    fs.readFile(configFilePath, function(err, data) {
      if (cb) {
        cb(JSON.parse(data.toString()));
      }
    });
  } else {
    console.log("config file is not a file!");
  }
}

function stop(item, cb) {
  var command = item.command, 
      pidFile = item.pid_file,
      logFile = item.log_file,
      signal  = item.signal;
      
  fs.readFile(pidFile, function(err, data) {
    if (data) {
      var pid = parseInt(data.toString().match(/(\d+)/)[0]) || 0;
      if (pid && signal) {
        try {
          process.kill(pid, signal);
          globalLogger(Date().toLocaleString() + " : killed: "+pid);
        } catch(e) {
          globalLogger(Date().toLocaleString() + " : could not find pid to kill: "+pid);
        }
      }
    }
    
    if (cb) {cb(item)}
  });
}

function start(item, cb) {
  var command = item.command, 
      pidFile = item.pid_file,
      logFile = item.log_file,
      signal  = item.signal;

  var cmds = command.split(' ');
  var child = spawn(cmds.shift(), cmds, { cwd: item.working_directory, env: process.env});
  globalLogger(Date().toLocaleString() + " : spawn pid: "+child.pid+" from command: "+command);
  var fd = fs.openSync(pidFile, 'w+');
  var pidString = child.pid.toString();
  item.pid = child.pid;
  fs.writeSync(fd, new Buffer(pidString, 'ascii'), 0, pidString.length, 0);
  fs.closeSync(fd);
  var appender = logAppender(logFile);
  child.stdout.on('data', appender);
  child.stderr.on('data', appender);
  child.on('exit', function() {
    globalLogger(Date().toLocaleString() + " : exited: "+child.pid);
  });
  child.stdout.end();
  child.stderr.end();
  
  if (cb) {cb(item)}
}


function restart(item) {
  stop(item, start)
}

function startServer(config) {
  var watchedFiles = [];
  var emailServer;

  // configure global logger
  if (config.global_log_file) {
    var appender = logAppender(config.global_log_file);
    globalLogger = function(str) {appender(new Buffer(str+"\n"))};
  } else {
    globalLogger = console.log;
  }

  function getChildPids() {
    return config.restartables.reduce(function(array, item) {
      if (item.pid) {
        array.push(item.pid);
      }
      return array
    }, []);
  }
  
  function checkRunning(cb, lastcb) {
    checkProcess(getChildPids(), function(runningPids) {
      config.restartables.forEach(function(item) {
        try {
          var isRunning = !!runningPids[item.pid.toString()];
          cb(item, isRunning);
        } catch (e) {
          cb(item, false);
        }
      });
      if (lastcb) {
        lastcb();
      }
    });
  }
  
  function reloadServer() {
    // clear process checker
    clearInterval(keepAliveInterval);
    // stop monitor server
    if (server) {
      server.close();
    }
    // stop everything
    globalLogger(Date().toLocaleString() + " : stopping all processes because of global watch file!");
    config.restartables.forEach(function(item) {
      stop(item);
    });
    // unwatch all watched files
    watchedFiles.forEach(function(file) {
      fs.unwatchFile(file);
    });
    // reread configuration and start restarter
    readConfig(function(configJson) {
      startServer(configJson);
    });
  }
  
  if (config.email_notification) {
    var settings = config.email_notification;
    emailServer = email.server.connect({
         user: settings.user, 
         password: settings.password,
         host: settings.host, 
         ssl: settings.ssl
     });
  }
  
  function sendEmail(subject, text, cb) {
    if (emailServer) {
      var settings = config.email_notification;
      globalLogger('Sending email: ' + subject);
      emailServer.send({
          text: text, 
          from: settings.from, 
          to: settings.to,
          subject: subject
      }, function(err, message) {
        if (err) {
          globalLogger('SEND EMAIL ERROR: ' + err.message);
        } else {
          if (cb) {cb(message)}
        }
      });
    }
  }
  
  function tailFile(filename, errorCallback, successCallback) {
    fs.stat(filename, function(err, stats) {
      if (err) {
        if (errorCallback) {
          errorCallback(err);
        }
      } else {
        var outputs = [];
        var start = stats.size > 1000 ? (stats.size - 1000) : 0;
        var stream = fs.createReadStream(filename, {start: start, end: stats.size});
        stream.addListener( "data", function(chunk) {
          outputs.push(chunk.toString());
        }).addListener( "close",function() {
          successCallback(outputs.join(''));
        });
      }
    });
  }
  
  // start server
  var server = net.createServer(function (sock) {
    function send(obj) {
      sock.write(JSON.stringify({success: obj}));
    }
    function sendError(obj) {
      sock.write(JSON.stringify({error: obj}));
    }
    sock.on('data', function(data) {
      try {
        var incomingPacket = JSON.parse(data.toString());
        // process commands from client
        var args = incomingPacket.command;
        if (args) {
          var command = args.shift();
          switch (command) {
            case 'status':
              var status = '\nCurrently running:\n\n';
              checkRunning(function(item, isRunning) {
                var pid = item.pid;
                if (pid) {
                  if (isRunning) {
                    status += "\t[ " + item.command + " ]  is alive at: "+pid+"\n";
                  } else {
                    status += "\t[ " + item.command + " ]  is dead!\n";
                  }
                }
              }, function() {
                send(status);
              });
              break;
            case 'stop':
              if (args.length == 0) {
                sendError('specify a matching regex on the command you want to stop');
              } else {
                var regex = new RegExp(args[0]);
                var status = '\nStopping the following:\n\n';
                checkRunning(function(item, isRunning) {
                  var pid = item.pid;
                  if (pid) {
                    if (isRunning && item.command.match(regex)) {
                      status += "\t[ " + item.command + " ] at: "+pid+" will be stopped!\n";
                      item.ignore = true;
                      stop(item);
                    }
                  }
                }, function() {
                  send(status);
                });
              }
              break;
            case 'start':
              if (args.length == 0) {
                sendError('specify a matching regex on the command you want to start');
              } else {
                var regex = new RegExp(args[0]);
                var status = '\nStarting the following:\n\n';
                checkRunning(function(item, isRunning) {
                  var pid = item.pid;
                  if (pid) {
                    if (!isRunning && item.command.match(regex)) {
                      status += "\t[ " + item.command + " ] will be started.\n";
                      item.ignore = false;
                      start(item);
                    }
                  }
                }, function() {
                  send(status);
                });
              }
              break;
            case 'exit':
              // stop everything
              globalLogger(Date().toLocaleString() + " : stopping all processes because client issued a remote command");
              var status = '\nStopping the following:\n\n';
              checkRunning(function(item, isRunning) {
                var pid = item.pid;
                if (pid) {
                  if (isRunning) {
                    status += "\t[ " + item.command + " ] at: "+pid+" will be stopped!\n";
                    item.ignore = true;
                    stop(item);
                  }
                }
              }, function() {
                status += "\nrestarter is exiting!!\n\n";
                send(status);
                if (server) {
                  server.close();
                }
                setTimeout(function() {
                  process.exit(0);
                }, 1000);
              });
              break;
            case 'log':
              if (args[0]) {
                // tail the log file for the matching process
                var log = '';
                var regex = new RegExp(args[0]);
                checkRunning(function(item, isRunning) {
                  if (item.command.match(regex)) {
                    tailFile(config.global_log_file, function(err) {
                      sendError('missing log file for: '+item.command);
                    }, function (log) {
                      send("Log file output for: "+item.command+"\n\n"+log);
                    });
                  }
                });
              } else {
                // if no regex is specified, we tail the global log
                tailFile(config.global_log_file, function(err) {
                  sendError('missing log file for restarter system');
                }, function (log) {
                  send("Log file output for restarter system\n\n"+log);
                });
              }
              break;
            case 'reload':
              send('stopping everything, re-reading configuration, and restarting restarter');
              reloadServer();
              break;
            default:
              sendError('unknown command');
          }
        } else {
          globalLogger('unknown commands sent from remote client: '+data.toString());
        }
      } catch (e) {
        sendError('bad command');
      }
    })
  });
  server.listen(config.server_sock || DEFAULT_SERVER_SOCK);

  // loop through restarter items and start them
  if (config.restartables && config.restartables.constructor === Array) {
    if (config.global_working_directory) {
      process.chdir(config.global_working_directory);
    }
    if (config.keep_alive) {
      keepAliveInterval = setInterval(function() {
        checkRunning(function(item, isRunning) {
          var pid = item.pid;
          if (pid && !isRunning && !item.ignore) {
            globalLogger(Date().toLocaleString() + " : keep alive command died, pid: "+pid+" for command: "+item.command);
            globalLogger(Date().toLocaleString() + " : rerunning command: "+item.command);
            restart(item);
            tailFile(item.log_file, null, function (log) {
              sendEmail("[restarter] command dies: "+item.command, "Log tail: \n\n"+log);
            });
          }
        });
      }, 2000);
    }
    if (config.global_watch_file) {
      // if global_watch_file is touched, we will stop everything, re-read config, and reload server
      watchedFiles.push(config.global_watch_file);
      fs.watchFile(config.global_watch_file, function () {
        reloadServer();
        tailFile(config.global_log_file, null, function (log) {
          sendEmail("[restarter] global watch file touched, reloading restarter", "Log tail: \n\n"+log);
        });
      });
    }
    config.restartables.forEach(function(item) {
      var watchFile = item.watch_file;
      if (watchFile) {
        try {
          if (!fs.statSync(watchFile).isFile()) {
            // throw error if the watchFile is a directory, symlink, or other file type
          }
        } catch(e) {
          var fd = fs.openSync(watchFile, 'w+');
          fs.writeSync(fd, new Buffer("x"), 0, 1, 0);
          fs.closeSync(fd);
        }
        restart(item);
        watchedFiles.push(watchFile);
        fs.watchFile(watchFile, function () {
          globalLogger(Date().toLocaleString() + " : watch file updated for command: "+item.command);
          restart(item);
          tailFile(item.log_file, null, function (log) {
            sendEmail("[restarter] watch file touched, restarting command: "+item.command, "Log tail:\n\n"+log);
          });
        });
      }    
    });
  }
}

function startClient(command, config) {
  var serverSock = DEFAULT_SERVER_SOCK;
  if (config) {
    serverSock = config.server_sock || DEFAULT_SERVER_SOCK;
  }
  if (serverSock) {
    fs.stat(serverSock, function(err) {
      if (err) {
        console.log('\nERROR: restarter is probably not running, you need to start it before you can run client commands!\n');
      } else {
        var sock = new net.Socket();
        sock.connect(serverSock, function(c) {
          sock.write(JSON.stringify({command: command}));
          sock.on('data', function(data) {
            try {
              var incomingPacket = JSON.parse(data.toString());
              // receive command output from server
              if (incomingPacket.success) {
                console.log(incomingPacket.success);
              } else if (incomingPacket.error) {
                console.log(incomingPacket.error);
              } else {
                console.log('unknown response from server');
              }
            } catch (e) {
              console.log(e);
            }
            sock.end()
          });
        });
      }
    });
  } else {
    console.log('no socket file specified!');
  }
}

exports.server = function(filePath) {
  configFilePath = filePath;
  readConfig(function(configJson) {
    if (configJson.daemon_log_file) {
      daemon.daemonize(configJson.daemon_log_file, configJson.global_pid_file, function (err, pid) {
        if (err) {
          console.log('error daemonizing');
          process.exit(0);
        }
        startServer(configJson);
        process.pid = pid;
      });
    } else {
      console.log('You must specify a daemon_log_file parameter in the config');
    }
  });
};

exports.client = function(command, filePath) {
  if (filePath) {
    configFilePath = filePath;
    readConfig(function(configJson) {
      startClient(command, configJson);
    });
  } else {
    startClient(command);
  }
}